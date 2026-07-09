/**
 * Quick-capture sidebar view.
 *
 * Layout:
 *   1. Toolbar — refresh + sort toggle
 *   2. Input card — multi-line textarea + NOTE submit button (always
 *      writes to today)
 *   3. Timeline — continuous-scroll stream of days. Today is rendered at
 *      the top; scrolling near the bottom auto-loads earlier non-empty
 *      days. Each day is a sub-section: date header node + its entries.
 *
 * Reads daily notes (via obsidian-daily-notes-interface) and renders the
 * `## Journal` section of each day. Submitting writes `- HH:MM text` to
 * today's file, creating the file or heading if needed.
 */

import {
  Component,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Platform,
  TFile,
  WorkspaceLeaf,
  getAllTags,
  moment,
  requestUrl,
  setIcon,
} from 'obsidian';
import {
  appHasDailyNotesPluginLoaded,
  getAllDailyNotes,
  getDailyNote,
  getDateFromFile,
} from 'obsidian-daily-notes-interface';

import {
  JournalEntry,
  TAG_TOKEN_RE,
  deleteEntryFromSection,
  extractAudioEmbeds,
  extractImageEmbeds,
  findSection,
  formatTimeHHMM,
  parseJournalEntries,
  removeAudioEmbedsFromEntry,
  replaceEntryTextInSection,
  rewriteTagsInSection,
  stripAttachmentEmbeds,
  updateEntryLocationName,
} from './section';
import { readExifCaptureDate, readExifGpsLocation } from './exif';
import { reverseGeocodeCity } from './geocode';
import { encodeWebp } from './webp-encoder';
import {
  YearStats,
  AllTimeStats,
  computeYearStats,
  computeAllTimeStats,
  formatWordCount,
  getHeatmapLevel,
} from './stats';
import type SparkMemoPlugin from './main';
import { t, currentLocale } from './i18n';
import { notice } from './notice';

export const CAPTURE_VIEW_TYPE = 'spark-memo-capture-view';

/**
 * Which "delete" action the context menu picked. Surfacing this as a type
 * (instead of two booleans) keeps `executeDelete` and the confirm modal
 * exhaustive — adding a fourth mode in the future will fail to type-check
 * any switch that doesn't handle it.
 */
type DeleteMode = 'memo' | 'memo+audio' | 'audio-only';

/** One node ("segment") of the `/`-nested tag tree used by the tag-aggregation tab. */
interface TagTreeNode {
  /** This segment's own name, e.g. "child" for "#parent/child". */
  name: string;
  /** Full tag path from root, e.g. "#parent/child". */
  fullPath: string;
  /** Aggregated data for memos tagged with exactly `fullPath`, if any were. */
  own: { count: number; lastTs: number; entries: Array<{ file: TFile; date: moment.Moment; entry: JournalEntry }> } | null;
  children: Map<string, TagTreeNode>;
  /** own.count plus every descendant's count. */
  totalCount: number;
  /** Most recent lastTs across own + all descendants. */
  lastTs: number;
}

/** Per-day rendered chunk in the infinite-scroll timeline. */
interface DaySection {
  /** Local-day moment (00:00) for stable identity. */
  date: moment.Moment;
  /** Wrapper element for the day's date-header + entry rows. */
  el: HTMLElement;
  /** Lifecycle owner for this day's MarkdownRenderer.render calls. */
  scope: Component;
  /** Path of the daily note backing this day (may be null on a missing file). */
  filePath: string | null;
}

export class JournalCaptureView extends ItemView {
  private plugin: SparkMemoPlugin;

  // Top-level tab state
  private currentTab: 'capture' | 'stats' | 'search' | 'location' | 'tag' = 'capture';
  private tabBarEl!: HTMLElement;
  private capturePaneEl!: HTMLElement;
  private statsPaneEl!: HTMLElement;
  private captureTabBtn!: HTMLButtonElement;
  private statsTabBtn!: HTMLButtonElement;
  private searchTabBtn!: HTMLButtonElement;
  private locationTabBtn!: HTMLButtonElement;
  private tagAggTabBtn!: HTMLButtonElement;

  // Search state
  private searchBarEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private randomMemoBtn!: HTMLButtonElement;
  private searchActive = false;
  private searchDebounceTimer: number | null = null;
  private searchQuery = '';
  private searchVersion = 0;
  /** All daily note files sorted newest→oldest, set at search start. */
  private searchFileQueue: TFile[] = [];
  /** Index into searchFileQueue: next file to scan in loadMoreSearchResults. */
  private searchCursor = 0;

  // Location-aggregation tab state
  private locationBarEl!: HTMLElement;
  private locationBackBtn!: HTMLButtonElement;
  private locationTitleEl!: HTMLElement;
  /** City name → aggregated memo data, built by a one-time full scan. Invalidated on any md file change. */
  private locationIndex: Map<
    string,
    { count: number; lastTs: number; entries: Array<{ file: TFile; date: moment.Moment; entry: JournalEntry }> }
  > | null = null;
  private locationLoading = false;
  /** Non-null while viewing a single city's memo list; null while viewing the city list. */
  private selectedLocationCity: string | null = null;

  // Tag-aggregation tab state
  private tagAggBarEl!: HTMLElement;
  private tagAggBackBtn!: HTMLButtonElement;
  private tagAggTitleEl!: HTMLElement;
  /** `#tag` → aggregated memo data, built by a one-time full scan. Invalidated on any md file change. */
  private tagAggIndex: Map<
    string,
    { count: number; lastTs: number; entries: Array<{ file: TFile; date: moment.Moment; entry: JournalEntry }> }
  > | null = null;
  private tagAggLoading = false;
  /** In-flight `loadTagIndex` scan, so concurrent callers await the same build instead of racing past a half-built index. */
  private tagAggLoadPromise: Promise<void> | null = null;
  /** Non-null while viewing a single tag's memo list; null while viewing the tag list. */
  private selectedTag: string | null = null;
  /** Full paths (e.g. "#parent/child") of tag-tree nodes currently expanded in the tag list. */
  private expandedTagPaths: Set<string> = new Set();

  // DOM references (capture pane)
  private inputCardEl!: HTMLElement;
  private dayNavEl!: HTMLElement;
  private prevDayBtn!: HTMLButtonElement;
  private nextDayBtn!: HTMLButtonElement;
  private calendarBtn!: HTMLButtonElement;
  private timelineEl!: HTMLElement;
  private sentinelEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  /** Vault-wide tag list (frontmatter + inline `#tags`), sorted by usage. Rebuilt lazily; invalidated on metadata changes. */
  private tagCache: { tag: string; count: number; mtime: number }[] | null = null;
  private tagSuggestEl!: HTMLElement;
  /** Character range in `textareaEl.value` of the `#partial` currently being completed, or null while the popup is closed. */
  private tagSuggestRange: { start: number; end: number } | null = null;
  private tagSuggestMatches: string[] = [];
  private tagSuggestIndex = 0;
  /** Vault-wide markdown file list, sorted by name. Rebuilt lazily; invalidated on vault/metadata changes. */
  private mentionCache: TFile[] | null = null;
  private mentionSuggestEl!: HTMLElement;
  /** Character range in `textareaEl.value` of the `@partial` currently being completed, or null while the popup is closed. */
  private mentionSuggestRange: { start: number; end: number } | null = null;
  private mentionSuggestMatches: TFile[] = [];
  private mentionSuggestIndex = 0;
  private submitBtn!: HTMLButtonElement;
  private attachmentListEl!: HTMLElement;
  private captureTimePillEl!: HTMLElement;
  private locationPillEl!: HTMLElement;
  private metadataHintPillEl!: HTMLElement;
  /** Images picked but not yet appended to the note text; flushed on submit. */
  private pendingImages: TFile[] = [];
  /** Hard cap on pending images per entry — keeps the preview grid to a single row/2×2 square. */
  private static readonly MAX_PENDING_IMAGES = 9;
  private static readonly MAX_PENDING_AUDIO = 1;
  /** Recordings made but not yet appended to the note text; flushed on submit. */
  private pendingAudio: { file: TFile; duration: string }[] = [];
  /**
   * Date + HH:MM taken from a photo's capture time, overriding "today, now"
   * for the next submit — the entry is written into `date`'s daily note
   * instead of today's. Set when the user opts into a captured-time
   * mismatch prompt (see `maybeCheckImageTime`); cleared once the pending
   * images are empty or the entry is submitted.
   */
  private pendingCaptureOverride: { date: moment.Moment; time: string } | null = null;
  /**
   * GPS coordinate read from a photo's EXIF, plus its (async-resolved)
   * coarse place name. Set as soon as GPS is found — `name` starts `null`
   * while reverse geocoding is in flight. Cleared once the pending images
   * are empty or the entry is submitted.
   */
  private pendingLocation: { latitude: number; longitude: number; name: string | null } | null = null;
  /**
   * Detected capture-time/GPS metadata that the user declined or dismissed
   * (e.g. an accidental click while several photos were still being
   * processed) — kept around so the "apply photo info?" hint pill can bring
   * the confirm modal back without re-adding the photo. New-entry
   * composition only (see `confirmAndApplyMetadata`); never populated while
   * editing an existing entry. Cleared once applied, dismissed, the pending
   * images are emptied, or the entry is submitted/edit is cancelled.
   */
  private pendingMetadataHint: {
    capturedAt: Date | null;
    diffMinutes: number;
    gpsCoord: { latitude: number; longitude: number } | null;
  } | null = null;
  /**
   * Snapshot of the metadata last *applied* from `confirmAndApplyMetadata`
   * (i.e. the pill(s) it turned into `pendingCaptureOverride`/`pendingLocation`).
   * If the user then removes both of those pills, `maybeRestoreMetadataHintAfterClear`
   * turns this back into a `pendingMetadataHint` instead of silently losing the
   * offer — same lifecycle/edit-mode rules as the hint itself.
   */
  private lastAppliedMetadata: {
    capturedAt: Date | null;
    diffMinutes: number;
    gpsCoord: { latitude: number; longitude: number } | null;
  } | null = null;
  /**
   * Set while the input box holds an existing entry's text for editing
   * (triggered from the entry's context menu). While set, submit rewrites
   * this entry in place instead of appending a new one. Cleared on submit
   * or cancel.
   */
  private editingEntry: { day: DaySection; entry: JournalEntry } | null = null;
  private editingPillEl!: HTMLElement;
  /** Wrapper above the textarea that holds editing / capture-time / location / metadata-hint pills side by side. */
  private topPillRowEl!: HTMLElement;
  /** The 📍 button (mobile only). Kept as a ref so it can be disabled while a `pendingLocation` is already set. */
  private geoBtnEl: HTMLButtonElement | null = null;

  // DOM references (stats pane)
  private statsToolbarEl!: HTMLElement;
  private statsBodyEl!: HTMLElement;
  private statsYearLabelEl!: HTMLElement;

  // Stats state
  private statsLoading = false;
  private statsRefreshTimer: number | null = null;
  /** Current year's stats (only one entry — kept as a map for renderer reuse). */
  private allYearStats: Map<number, YearStats> = new Map();
  /** Aggregated stats across every year found in the vault. */
  private allTimeStats: AllTimeStats | null = null;
  /** Distinct cities visited (location tags), cached per year alongside `allYearStats`. */
  private yearCities: Map<number, Set<string>> = new Map();
  /** Distinct cities across every cached year — merged from `yearCities`. */
  private statsLocationCount = 0;
  /**
   * Years that need re-scanning on the next `loadAllStats` pass. `null` means
   * "rescan everything" (initial load, or after a rename/delete we can't
   * attribute to a single year) — otherwise only these years' daily notes are
   * re-read; every other year keeps its previously cached `YearStats`. Keeps
   * the cost of a single memo save independent of how many years of journal
   * history the vault holds.
   */
  private dirtyYears: Set<number> | null = null;

  // Cached state
  private days: DaySection[] = [];
  /** The single day currently shown in the capture timeline. Changed via the prev/next/calendar nav. */
  private currentDate: moment.Moment = moment().startOf('day');
  /** Day immediately older than the oldest loaded day; next `loadMore` starts here. */
  private nextProbeDate: moment.Moment = moment().startOf('day').subtract(1, 'day');
  /** True once we've scanned far enough back that nothing earlier exists. */
  private exhausted = false;
  private loadingMore = false;
  /** Max calendar days we'll probe in a single loadMore call. */
  private readonly probeWindow = 30;
  /** Hard floor: refuse to scan further back than this many days from today. */
  private readonly maxLookbackDays = 365;
  private rerenderTimer: number | null = null;
  private intersectionObs: IntersectionObserver | null = null;

  // ── Quick-record via URL scheme ──────────────────────────────────────────
  /** Bound to the inner startRecording closure once buildInputCard runs. */
  private startRecordingFn: (() => Promise<void>) | null = null;

  /**
   * Called by the plugin's URL handler when `cmd=record` is received.
   * Ensures the capture pane is visible, then starts recording immediately.
   * Safe to call before `buildInputCard` finishes (startRecordingFn will be
   * null until then, so we schedule a short retry).
   */
  public async beginRecording(): Promise<void> {
    // Make sure we're on the capture tab so the mic button is visible
    if (this.currentTab !== 'capture') this.switchTab('capture');

    if (this.startRecordingFn) {
      await this.startRecordingFn();
    } else {
      // If the view isn't fully built yet, retry once the event loop settles
      window.setTimeout(async () => {
        if (this.startRecordingFn) await this.startRecordingFn();
      }, 200);
    }
  }

  // ── Mobile toolbar auto-hide (scroll-direction triggered) ──
  /** Last observed scrollTop, for direction detection. */
  private lastScrollTop = 0;
  /** Bound scroll handler we install on the view's scroll container. */
  private onScrollBound: (() => void) | null = null;
  /** Element we attached the scroll listener to, kept for clean removal. */
  private scrollEl: HTMLElement | null = null;
  /** Min pixel delta between events that counts as a real scroll move. */
  private readonly scrollDeltaThreshold = 6;

  constructor(leaf: WorkspaceLeaf, plugin: SparkMemoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CAPTURE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t('app.name');
  }

  getIcon(): string {
    return 'sparkle';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('jp-capture-root');

    // Top-level tab bar — switches between "Quick capture" and "Yearly stats".
    this.buildTabBar(root as HTMLElement);

    // Capture pane (default visible)
    this.capturePaneEl = (root as HTMLElement).createDiv({ cls: 'jp-pane jp-pane-capture' });
    this.buildInputCard(this.capturePaneEl);
    this.buildTimeline(this.capturePaneEl);

    // Stats pane (hidden initially; built lazily on first switch)
    this.statsPaneEl = (root as HTMLElement).createDiv({ cls: 'jp-pane jp-pane-stats' });
    this.statsPaneEl.style.display = 'none';


    // ── Vault listeners ──
    // modify: refresh the affected day's section in place (no full rebuild)
    this.registerEvent(
      this.app.vault.on('modify', file => {
        if (!(file instanceof TFile)) return;
        const day = this.days.find(d => d.filePath === file.path);
        if (day) {
          this.scheduleDayRefresh(day);
        }
        if (file.extension === 'md') {
          this.markStatsDirtyForFile(file);
          this.scheduleStatsRefresh();
          this.locationIndex = null;
          this.tagAggIndex = null;
        }
      }),
    );
    // create: a new daily note (today, or an older one) — full rebuild
    this.registerEvent(
      this.app.vault.on('create', file => {
        if (file instanceof TFile && file.extension === 'md') {
          this.scheduleFullRebuild();
          this.markStatsDirtyForFile(file);
          this.scheduleStatsRefresh();
          this.locationIndex = null;
          this.tagAggIndex = null;
        }
      }),
    );
    // delete: drop the day if it was loaded, then rebuild
    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (file instanceof TFile && this.days.some(d => d.filePath === file.path)) {
          this.scheduleFullRebuild();
        }
        if (file instanceof TFile && file.extension === 'md') {
          this.markStatsDirtyForFile(file);
          this.scheduleStatsRefresh();
          this.locationIndex = null;
          this.tagAggIndex = null;
        }
      }),
    );
    // rename: the year encoded in a daily note's filename could change, and
    // we can't cheaply re-derive the *old* year from a bare path string —
    // fall back to a full rescan on the next stats pass rather than risk a
    // stale cached year.
    this.registerEvent(
      this.app.vault.on('rename', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.dirtyYears = null;
          this.scheduleStatsRefresh();
        }
      }),
    );

    await this.fullRebuild();
    this.setupIntersectionObserver();
    this.setupMobileToolbarAutoHide();
  }

  async onClose(): Promise<void> {
    if (this.rerenderTimer !== null) {
      window.clearTimeout(this.rerenderTimer);
      this.rerenderTimer = null;
    }
    if (this.statsRefreshTimer !== null) {
      window.clearTimeout(this.statsRefreshTimer);
      this.statsRefreshTimer = null;
    }
    if (this.searchDebounceTimer !== null) {
      window.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    if (this.intersectionObs) {
      this.intersectionObs.disconnect();
      this.intersectionObs = null;
    }
    this.teardownMobileToolbarAutoHide();
    this.disposeDays();
    this.containerEl.children[1].empty();
  }

  // ── DOM construction ────────────────────────────────────────────────────

  private buildTabBar(root: HTMLElement) {
    this.tabBarEl = root.createDiv({ cls: 'jp-tab-bar' });

    this.captureTabBtn = this.makeTabBtn('zap', true, t('capture.quickCapture'));
    this.captureTabBtn.addEventListener('click', () => this.switchTab('capture'));

    this.searchTabBtn = this.makeTabBtn('search', false, t('search.searchJournal'));
    this.searchTabBtn.addEventListener('click', () => this.switchTab('search'));

    this.tagAggTabBtn = this.makeTabBtn('tags', false, t('tag.aggregation'));
    this.tagAggTabBtn.addEventListener('click', () => this.switchTab('tag'));

    this.locationTabBtn = this.makeTabBtn('map-pin', false, t('location.aggregation'));
    this.locationTabBtn.addEventListener('click', () => this.switchTab('location'));

    this.statsTabBtn = this.makeTabBtn('bar-chart-2', false, t('stats.yearlyStats'));
    this.statsTabBtn.addEventListener('click', () => this.switchTab('stats'));

    // Search bar — collapsed by default, shown when search tab is active
    this.searchBarEl = root.createDiv({ cls: 'jp-search-bar' });
    this.searchBarEl.style.display = 'none';

    const searchIcon = this.searchBarEl.createSpan({ cls: 'jp-search-bar-icon' });
    setIcon(searchIcon, 'search');

    this.searchInputEl = this.searchBarEl.createEl('input', {
      cls: 'jp-search-input',
      attr: { placeholder: t('search.searchJournalPlaceholder'), type: 'text' },
    });
    this.searchInputEl.addEventListener('input', () => {
      const q = this.searchInputEl.value;
      this.searchQuery = q;
      if (this.searchDebounceTimer !== null) window.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = window.setTimeout(() => {
        this.searchDebounceTimer = null;
        void this.runSearch(q.trim());
      }, 300);
    });

    this.randomMemoBtn = this.searchBarEl.createEl('button', {
      cls: 'jp-search-bar-random-btn',
      attr: { 'aria-label': t('search.randomMemo'), title: t('search.randomMemo') },
    });
    setIcon(this.randomMemoBtn, 'dice');
    this.randomMemoBtn.addEventListener('click', () => void this.showRandomMemo());

    // Tag bar — collapsed by default, shown when the tag tab is active
    this.tagAggBarEl = root.createDiv({ cls: 'jp-location-bar' });
    this.tagAggBarEl.style.display = 'none';

    this.tagAggBackBtn = this.tagAggBarEl.createEl('button', {
      cls: 'jp-location-back-btn',
      attr: { 'aria-label': t('tag.backToList'), title: t('tag.backToList') },
    });
    setIcon(this.tagAggBackBtn, 'arrow-left');
    this.tagAggBackBtn.style.display = 'none';
    this.tagAggBackBtn.addEventListener('click', () => this.backToTagList());

    this.tagAggTitleEl = this.tagAggBarEl.createDiv({ cls: 'jp-location-bar-title', text: t('tag.all') });

    // Location bar — collapsed by default, shown when location tab is active
    this.locationBarEl = root.createDiv({ cls: 'jp-location-bar' });
    this.locationBarEl.style.display = 'none';

    this.locationBackBtn = this.locationBarEl.createEl('button', {
      cls: 'jp-location-back-btn',
      attr: { 'aria-label': t('location.backToList'), title: t('location.backToList') },
    });
    setIcon(this.locationBackBtn, 'arrow-left');
    this.locationBackBtn.style.display = 'none';
    this.locationBackBtn.addEventListener('click', () => this.backToLocationList());

    this.locationTitleEl = this.locationBarEl.createDiv({ cls: 'jp-location-bar-title', text: t('location.all') });
  }

  /** Build one icon-only tab button. */
  private makeTabBtn(icon: string, active: boolean, tooltip?: string): HTMLButtonElement {
    const btn = this.tabBarEl.createEl('button', {
      cls: 'jp-tab-btn' + (active ? ' is-active' : ''),
      attr: tooltip ? { 'aria-label': tooltip, title: tooltip } : {},
    });
    const iconEl = btn.createSpan({ cls: 'jp-tab-btn-icon' });
    setIcon(iconEl, icon);
    return btn;
  }

  private switchTab(tab: 'capture' | 'stats' | 'search' | 'location' | 'tag') {
    if (this.currentTab === tab) return;
    const prevTab = this.currentTab;
    this.currentTab = tab;

    this.captureTabBtn.toggleClass('is-active', tab === 'capture');
    this.searchTabBtn.toggleClass('is-active', tab === 'search');
    this.statsTabBtn.toggleClass('is-active', tab === 'stats');
    this.locationTabBtn.toggleClass('is-active', tab === 'location');
    this.tagAggTabBtn.toggleClass('is-active', tab === 'tag');

    if (tab === 'search') {
      this.capturePaneEl.style.display = '';
      this.statsPaneEl.style.display = 'none';
      this.inputCardEl.style.display = 'none';
      this.searchBarEl.style.display = '';
      this.locationBarEl.style.display = 'none';
      this.tagAggBarEl.style.display = 'none';
      this.searchActive = true;

      if (prevTab !== 'search') {
        if (this.searchQuery.length === 0) {
          this.disposeDays();
          this.timelineEl.empty();
          this.exhausted = false;
          this.searchFileQueue = [];
          this.searchCursor = 0;
          void this.showRandomMemo();
        }
        this.searchInputEl.value = this.searchQuery;
        window.setTimeout(() => this.searchInputEl.focus(), 50);
      }
    } else if (tab === 'capture') {
      this.capturePaneEl.style.display = '';
      this.statsPaneEl.style.display = 'none';
      this.inputCardEl.style.display = '';
      this.searchBarEl.style.display = 'none';
      this.locationBarEl.style.display = 'none';
      this.tagAggBarEl.style.display = 'none';

      // Always clean up search state when returning to capture
      if (this.searchActive || prevTab === 'search') {
        this.searchActive = false;
        if (this.searchDebounceTimer !== null) {
          window.clearTimeout(this.searchDebounceTimer);
          this.searchDebounceTimer = null;
        }
      }
      // Rebuild if coming from any non-capture tab, or if timeline looks stale
      // (e.g. capture → search → capture leaves search content in timelineEl)
      if (prevTab !== 'capture') {
        void this.fullRebuild();
      }
    } else if (tab === 'location') {
      this.capturePaneEl.style.display = '';
      this.statsPaneEl.style.display = 'none';
      this.inputCardEl.style.display = 'none';
      this.searchBarEl.style.display = 'none';
      this.locationBarEl.style.display = '';
      this.tagAggBarEl.style.display = 'none';

      if (prevTab !== 'location') {
        this.disposeDays();
        this.timelineEl.empty();
        this.selectedLocationCity = null;
        this.locationBackBtn.style.display = 'none';
        this.locationTitleEl.setText(t('location.all'));
        void this.loadLocationIndex().then(() => {
          // Bail if the user already navigated away or picked a city while scanning
          if (this.currentTab === 'location' && this.selectedLocationCity === null) {
            this.renderLocationList();
          }
        });
      }
    } else if (tab === 'tag') {
      this.capturePaneEl.style.display = '';
      this.statsPaneEl.style.display = 'none';
      this.inputCardEl.style.display = 'none';
      this.searchBarEl.style.display = 'none';
      this.locationBarEl.style.display = 'none';
      this.tagAggBarEl.style.display = '';

      if (prevTab !== 'tag') {
        this.disposeDays();
        this.timelineEl.empty();
        this.selectedTag = null;
        this.tagAggBackBtn.style.display = 'none';
        this.tagAggTitleEl.setText(t('tag.all'));
        void this.loadTagIndex().then(() => {
          // Bail if the user already navigated away or picked a tag while scanning
          if (this.currentTab === 'tag' && this.selectedTag === null) {
            this.renderTagList();
          }
        });
      }
    } else {
      // stats tab
      this.capturePaneEl.style.display = 'none';
      this.statsPaneEl.style.display = '';
      this.inputCardEl.style.display = '';
      this.searchBarEl.style.display = 'none';
      this.locationBarEl.style.display = 'none';
      this.tagAggBarEl.style.display = 'none';

      if (this.statsPaneEl.childElementCount === 0) {
        this.buildStatsPane();
      }
      void this.loadAllStats();
    }
  }

  private toggleSearch() {
    if (this.currentTab === 'search') {
      this.switchTab('capture');
    } else {
      this.switchTab('search');
    }
  }

  private async runSearch(query: string) {
    if (!this.searchActive) return;

    // Version stamp — any newer call invalidates this one
    const version = ++this.searchVersion;

    this.disposeDays();
    this.timelineEl.empty();
    this.exhausted = false;
    this.searchFileQueue = [];
    this.searchCursor = 0;

    if (query.length === 0) {
      this.renderTopLevelMessage(t('search.typeToSearch'));
      return;
    }

    if (!appHasDailyNotesPluginLoaded()) {
      this.renderTopLevelMessage(t('notice.dailyNotesRequired'));
      return;
    }

    this.renderTopLevelMessage(t('search.searching'));

    // Build the sorted file queue (newest → oldest) once, then scan lazily
    const allNotes = getAllDailyNotes() as Record<string, TFile>;
    const queue: Array<{ date: moment.Moment; file: TFile }> = [];
    for (const file of Object.values(allNotes)) {
      if (!(file instanceof TFile)) continue;
      const date = getDateFromFile(file as TFile, 'day');
      if (date) queue.push({ date: date.clone().startOf('day'), file });
    }
    queue.sort((a, b) => (a.date.isBefore(b.date) ? 1 : -1));
    this.searchFileQueue = queue.map(q => q.file);

    if (this.searchVersion !== version) return;

    // Kick off the first batch — sentinel / intersection observer handles the rest
    await this.loadMoreSearchResults();
  }

  /** Scan the next batch of files in searchFileQueue and append matching days. */
  private async loadMoreSearchResults(): Promise<void> {
    if (!this.searchActive || this.loadingMore) return;
    // No queue built yet (user hasn't typed anything) — do nothing
    if (this.searchFileQueue.length === 0) return;
    this.loadingMore = true;

    const version = this.searchVersion;
    const query = this.searchQuery;
    const lower = query.toLowerCase();
    const batchSize = 20;
    let found = 0;

    try {
      while (this.searchCursor < this.searchFileQueue.length && found < batchSize) {
        if (this.searchVersion !== version) return;

        const file = this.searchFileQueue[this.searchCursor++];
        const date = getDateFromFile(file, 'day');
        if (!date) continue;

        try {
          const content = await this.app.vault.cachedRead(file);
          const section = findSection(
            content,
            this.plugin.settings.targetHeading,
            this.plugin.settings.headingLevel,
          );
          if (!section) continue;
          const text = content.slice(section.from, section.to);
          const entries = parseJournalEntries(text, this.plugin.settings.timestampPattern);
          const matched = entries.filter(e => this.entryMatchesQuery(e.text, lower));
          if (matched.length === 0) continue;

          // Remove the "searching…" placeholder on first hit
          if (this.days.length === 0) this.timelineEl.empty();

          const day: DaySection = {
            date: date.clone().startOf('day'),
            el: createDiv({ cls: 'jp-timeline-day' }),
            scope: new Component(),
            filePath: file.path,
          };
          day.scope.load();
          this.renderSearchDayContent(day, matched, query);
          this.timelineEl.appendChild(day.el);
          this.days.push(day);
          found++;
        } catch {
          // skip unreadable files
        }
      }

      if (this.searchVersion !== version) return;

      if (this.searchCursor >= this.searchFileQueue.length) {
        this.exhausted = true;
        if (this.days.length === 0) {
          this.timelineEl.empty();
          this.renderTopLevelMessage(t('search.noResults', { query }));
        } else {
          this.markEndOfTimeline();
        }
      }
    } finally {
      this.loadingMore = false;
    }
  }

  /**
   * Check whether the searchable text of an entry contains the query.
   * Strips wiki-embeds and markdown image syntax before matching so that
   * file paths (e.g. "Recordings/2024-01-01_...m4a") don't cause false hits.
   */
  private entryMatchesQuery(text: string, lowerQuery: string): boolean {
    const stripped = text
      .replace(/!\[\[[^\]]*\]\]/g, '')  // remove ![[...]] embeds
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')  // remove ![alt](url) images
      .toLowerCase();
    return stripped.includes(lowerQuery);
  }

  /** Render search result entries with keyword highlight. */
  private renderSearchDayContent(day: DaySection, entries: JournalEntry[], query: string) {
    const headerLabel = this.formatDateHeader(day.date, entries.length);
    const headerRow = day.el.createDiv({ cls: 'jp-timeline-entry jp-timeline-entry--header' });
    headerRow.createDiv({ cls: 'jp-timeline-dot jp-timeline-dot--header' });
    const headerCard = headerRow.createDiv({ cls: 'jp-timeline-header-card' });
    const headerText = headerCard.createDiv({ cls: 'jp-timeline-header-text' });
    headerText.createEl('div', { cls: 'jp-timeline-header-title', text: headerLabel.title });
    headerText.createEl('div', { cls: 'jp-timeline-header-sub', text: t('search.matchCount', { count: String(entries.length) }) });
    this.addOpenNoteBtn(headerCard, day);

    const sourcePath = day.filePath ?? '';
    const sorted = [...entries].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b.lineIndex - a.lineIndex,
    );

    for (const entry of sorted) {
      const row = day.el.createDiv({ cls: 'jp-timeline-entry' });
      row.createDiv({ cls: 'jp-timeline-dot' });

      const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
      head.createEl('span', { cls: 'jp-timestamp', text: entry.timestamp });
      const { text: bodyText, location } = extractLocationTag(entry.text);
      if (location) this.renderLocationChip(head, day, entry, location);

      const bubble = row.createDiv({ cls: 'jp-timeline-bubble jp-search-bubble' });
      // Render markdown first, then highlight keywords in the resulting DOM text nodes
      void MarkdownRenderer.render(this.app, bodyText, bubble, sourcePath, day.scope).then(() => {
        this.highlightKeyword(bubble, query);
        this.applyImageGrid(bubble);
        this.attachImagePreviews(bubble);
        this.attachTagClickHandlers(bubble);
      });

      const openMenu = (evt: MouseEvent) => {
        evt.preventDefault();
        this.openEntryMenu(evt, day, entry);
      };
      head.addEventListener('contextmenu', openMenu);
      bubble.addEventListener('contextmenu', openMenu);
    }
  }

  /**
   * When a memo's images were submitted together (see `handleSubmit`, which
   * joins all pending images/audio into one space-separated line of
   * `![[...]]` embeds), Obsidian's renderer places them as sibling embed
   * spans wherever that line ends up in the DOM — not reliably inside a
   * `<p>`. If the memo body ends with a list (numbered notes, etc.) right
   * before the images with no blank line between them, the image line gets
   * absorbed as a "tight list" continuation directly inside that list
   * item's `<li>`, with no paragraph wrapper at all, only a `<br>`
   * separating it from the preceding text.
   *
   * So instead of assuming a wrapper tag, this groups image embeds by
   * whatever DOM parent they actually share, and — as long as nothing but
   * the embeds themselves and `<br>` separators sit between the first and
   * last embed in that parent — lifts that run out into its own grid
   * `<div>`, leaving any other sibling content (like the list item's text)
   * untouched.
   */
  private applyImageGrid(bubble: HTMLElement) {
    const embeds = Array.from(bubble.querySelectorAll('.internal-embed'))
      .filter(el => el.querySelector('img'));

    const byParent = new Map<Element, Element[]>();
    for (const embed of embeds) {
      const parent = embed.parentElement;
      if (!parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent)!.push(embed);
    }

    for (const [parent, group] of byParent) {
      if (group.length < 2) continue;

      const elementChildren = Array.from(parent.children);
      const first = elementChildren.indexOf(group[0]);
      const last = elementChildren.indexOf(group[group.length - 1]);
      const between = elementChildren.slice(first, last + 1);
      if (between.some(el => !group.includes(el) && el.tagName !== 'BR')) continue;

      const wrapper = document.createElement('div');
      wrapper.className = 'jp-timeline-image-grid';
      wrapper.setAttribute('data-count', String(group.length));
      parent.insertBefore(wrapper, group[0]);
      for (const el of between) {
        if (el.tagName === 'BR') el.remove();
      }
      for (const embed of group) wrapper.appendChild(embed);
    }
  }

  /**
   * Makes every embedded image in a rendered bubble clickable for a
   * full-screen preview (reuses the same `ImagePreviewModal` as the
   * pending-attachment thumbnails). Applies to single images too, not just
   * grid ones — otherwise a memo with exactly one photo would be the odd
   * one out.
   */
  private attachImagePreviews(bubble: HTMLElement) {
    for (const embed of Array.from(bubble.querySelectorAll('.internal-embed'))) {
      const img = embed.querySelector('img');
      if (!img) continue;
      (embed as HTMLElement).addEventListener('click', evt => {
        evt.preventDefault();
        evt.stopPropagation();
        new ImagePreviewModal(this.app, img.getAttribute('src') ?? '', img.getAttribute('alt') ?? '').open();
      });
    }
  }

  /**
   * Redirects clicks on rendered `#tag` links (Obsidian's own `a.tag`
   * anchors) away from core's default tag search and into this plugin's
   * tag aggregation tab instead.
   */
  private attachTagClickHandlers(bubble: HTMLElement) {
    for (const a of Array.from(bubble.querySelectorAll<HTMLAnchorElement>('a.tag'))) {
      a.addEventListener('click', evt => {
        evt.preventDefault();
        evt.stopPropagation();
        const tag = a.getAttribute('href') || a.textContent || '';
        if (tag) void this.openTagAggregation(tag);
      });
    }
  }

  /** Switches to the tag aggregation tab and drills straight into `tag`. */
  private async openTagAggregation(tag: string) {
    const normalized = tag.startsWith('#') ? tag : `#${tag}`;
    this.switchTab('tag');
    await this.ensureTagIndexAndRenderList();
    this.selectTag(normalized);
  }

  /** Walk DOM text nodes and wrap keyword occurrences in highlight spans. */
  private highlightKeyword(el: HTMLElement, query: string) {
    const lower = query.toLowerCase();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) nodes.push(node as Text);

    for (const textNode of nodes) {
      const text = textNode.nodeValue ?? '';
      const idx = text.toLowerCase().indexOf(lower);
      if (idx === -1) continue;

      const frag = document.createDocumentFragment();
      let cursor = 0;
      let pos = text.toLowerCase().indexOf(lower, cursor);
      while (pos !== -1) {
        if (pos > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, pos)));
        const mark = document.createElement('mark');
        mark.className = 'jp-search-highlight';
        mark.textContent = text.slice(pos, pos + query.length);
        frag.appendChild(mark);
        cursor = pos + query.length;
        pos = text.toLowerCase().indexOf(lower, cursor);
      }
      if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }


  private static readonly INPUT_PLACEHOLDERS = [
    "What's happening?",
    "What's on your mind?",
    "What's going on?",
    'Got something to jot down?',
    'What just happened?',
    'Anything worth remembering?',
    'What are you up to?',
    'Say something.',
    "What's new?",
    "Write it down before it slips away.",
  ];

  private pickRandomPlaceholder(): string {
    const pool = JournalCaptureView.INPUT_PLACEHOLDERS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private static readonly LOCATION_EMPTY_PLACEHOLDERS = [
    'No footprints on the map yet.',
    'Not a single place has found you yet.',
    'The map is still blank — for now.',
    'Somewhere, someday. Just not yet.',
    'Your atlas is waiting to be written.',
    'No dots on the map. No stories to tell.',
    "The world hasn't left a mark here yet.",
    'Still waiting for your first coordinate.',
  ];

  private pickRandomLocationEmptyPlaceholder(): string {
    const pool = JournalCaptureView.LOCATION_EMPTY_PLACEHOLDERS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private buildInputCard(root: HTMLElement) {
    this.inputCardEl = root.createDiv({ cls: 'jp-capture-card' });

    // Top-of-card pill row — holds the editing pill plus the capture-time /
    // location / metadata-hint pills, all lined up above the textarea so the
    // context of what will be submitted is visible in one place.
    this.topPillRowEl = this.inputCardEl.createDiv({ cls: 'jp-capture-top-pill-row' });

    // Editing-mode pill — shown once an existing entry is loaded into the
    // input box for editing. Clicking × cancels the edit.
    this.editingPillEl = this.topPillRowEl.createDiv({ cls: 'jp-capture-time-pill jp-capture-editing-pill jp-location-pill--hidden' });

    // Pending-image thumbnail strip — sits above the textarea, pushing it
    // down, so added images preview like an attachment card would.
    this.attachmentListEl = this.inputCardEl.createDiv({ cls: 'jp-capture-attachments jp-capture-attachments--empty' });

    // Wrapper for textarea
    const inputWrapper = this.inputCardEl.createDiv({ cls: 'jp-capture-input-wrapper' });

    this.textareaEl = inputWrapper.createEl('textarea', {
      cls: 'jp-capture-input',
      attr: {
        placeholder: this.pickRandomPlaceholder(),
        rows: '3',
      },
    });
    this.textareaEl.addEventListener('input', () => {
      this.refreshSubmitState();
      this.autoResizeTextarea();
      // Run synchronously (desktop / normal case) and again on the next tick.
      // On iOS software keyboards, `selectionStart` sometimes still points
      // *before* the just-inserted character when 'input' fires — the sync
      // pass would see caret=0 for a value of "#" and bail out. Deferring
      // gives the selection a chance to catch up so a lone "#" still opens
      // the popup.
      this.updateTagSuggestions();
      this.updateMentionSuggestions();
      window.setTimeout(() => {
        this.updateTagSuggestions();
        this.updateMentionSuggestions();
      }, 0);
    });
    // Cursor moves (arrow keys, clicks) don't fire 'input' — re-check the
    // trigger so the popup follows the caret / closes when it leaves the tag.
    this.textareaEl.addEventListener('keyup', (e: KeyboardEvent) => {
      // Navigation/selection keys are handled (and preventDefault'd) on
      // keydown below when a popup is open — nothing left to do here.
      const navKey = ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key);
      if (!(this.tagSuggestRange && navKey)) this.updateTagSuggestions();
      if (!(this.mentionSuggestRange && navKey)) this.updateMentionSuggestions();
    });
    this.textareaEl.addEventListener('click', () => {
      this.updateTagSuggestions();
      this.updateMentionSuggestions();
    });
    this.textareaEl.addEventListener('blur', () => {
      // Defer so a mousedown on the popup (which fires before blur) can
      // still register its click before we tear the list down.
      window.setTimeout(() => {
        this.closeTagSuggest();
        this.closeMentionSuggest();
      }, 0);
    });
    this.textareaEl.addEventListener('keydown', (e: KeyboardEvent) => {
      // Mention popup takes priority when both would otherwise react, since
      // the two triggers ('#' and '@') can never be active at the same time.
      if (this.mentionSuggestRange) {
        this.handleMentionSuggestKeydown(e);
      } else {
        this.handleTagSuggestKeydown(e);
      }
    });

    this.tagSuggestEl = inputWrapper.createDiv({ cls: 'jp-tag-suggest jp-tag-suggest--hidden' });
    this.mentionSuggestEl = inputWrapper.createDiv({ cls: 'jp-tag-suggest jp-mention-suggest jp-tag-suggest--hidden' });

    this.registerEvent(this.app.metadataCache.on('changed', () => {
      this.tagCache = null;
      this.mentionCache = null;
    }));
    this.registerEvent(this.app.vault.on('create', () => { this.mentionCache = null; }));
    this.registerEvent(this.app.vault.on('delete', () => { this.mentionCache = null; }));
    this.registerEvent(this.app.vault.on('rename', () => { this.mentionCache = null; }));
    // Image paste: intercept at document level (capture phase) for reliability
    this.registerDomEvent(document, 'paste', async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      // Only intercept if focus is inside our textarea
      if (!this.inputCardEl.contains(document.activeElement)) return;
      const images: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const blob = item.getAsFile();
        if (blob) images.push(blob);
      }
      if (images.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      await this.addImageFiles(images);
    }, true);
    // Image drag & drop
    this.textareaEl.addEventListener('drop', async (e) => {
      const files = e.dataTransfer?.files;
      if (!files) return;
      const images = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (images.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      await this.addImageFiles(images);
    });
    this.textareaEl.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    }, true);

    // Hidden file input for image upload
    const fileInput = this.inputCardEl.createEl('input', {
      cls: 'jp-capture-image-input',
      attr: {
        type: 'file',
        accept: 'image/*',
        multiple: 'true',
      },
    });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
      const files = fileInput.files;
      if (!files || files.length === 0) return;
      const images = Array.from(files).filter(f => f.type.startsWith('image/'));
      fileInput.value = '';
      if (images.length === 0) return;
      await this.addImageFiles(images);
    });

    // Hidden file input for image upload
    const recBar = this.inputCardEl.createDiv({ cls: 'jp-recording-bar' });
    recBar.style.display = 'none';
    const recWaveRow = recBar.createDiv({ cls: 'jp-recording-wave-row' });
    const recCanvas = recWaveRow.createEl('canvas', { cls: 'jp-recording-waveform' });
    const recMeta = recWaveRow.createDiv({ cls: 'jp-recording-meta' });
    const recTime = recMeta.createEl('span', { cls: 'jp-recording-time', text: '00:00' });
    const recStatus = recMeta.createEl('span', { cls: 'jp-recording-status', text: t('capture.recording') });
    // Centered stop button shown beneath the waveform while recording.
    const recStopBtn = recBar.createEl('button', {
      cls: 'jp-recording-stop',
      attr: { 'aria-label': t('capture.stop') },
    });
    setIcon(recStopBtn, 'square');

    let mediaRecorder: MediaRecorder | null = null;
    let audioChunks: Blob[] = [];
    let recordingTimeout: number | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let rafId: number | null = null;
    let recordStartedAt = 0;
    // Realtime STT state
    let realtimeProcessor: ScriptProcessorNode | null = null;
    let realtimeTimer: number | null = null;
    let segmentFrames: Float32Array[] = []; // current VAD segment being built
    let vadSilenceSamples = 0; // consecutive silent samples within the segment
    let vadSegmentSamples = 0; // total samples in the current segment
    let lastTranscript = ''; // trailing text from the previous segment → prompt context
    let realtimeBaseCursor = 0; // insertion point for streamed text
    let realtimeRegionStart = 0; // textarea index where the streamed region begins
    let realtimeActive = false; // whether live streaming is on for this session
    let pendingFlush: Promise<void> = Promise.resolve(); // serialize segment sends
    let vadFirstSegment = true; // until the first segment flushes, allow an early first-word cut
    // VAD tuning (sample-based so it adapts to any sample rate).
    const VAD_FRAME = 4096;            // ScriptProcessor buffer size
    const VAD_ENERGY_RMS = 0.012;      // below this RMS → considered silence (lowered so brief in-speech dips aren't misread as pauses)
    const VAD_SILENCE_CUT_SAMPLES = 0.45; // 450ms of silence ends a segment — long enough to ride through mid-sentence breaths
    const VAD_MAX_SEG_SAMPLES = 4.0;   // force-cut a segment at 4s (caps worst-case latency)
    const VAD_MIN_SEG_SAMPLES = 0.8;   // drop segments shorter than 0.8s
    const VAD_FIRST_FLUSH_SAMPLES = 2.4; // first segment flushes early — but not so early it splits the opening sentence

    const formatDuration = (ms: number) => {
      const total = Math.floor(ms / 1000);
      const m = String(Math.floor(total / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      return `${m}:${s}`;
    };

    const teardownAnalyser = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (realtimeTimer !== null) {
        window.clearInterval(realtimeTimer);
        realtimeTimer = null;
      }
      if (realtimeProcessor) {
        try { realtimeProcessor.disconnect(); } catch { /* noop */ }
        realtimeProcessor = null;
      }
      if (audioCtx) {
        void audioCtx.close();
        audioCtx = null;
        analyser = null;
      }
      segmentFrames = [];
      vadSilenceSamples = 0;
      vadSegmentSamples = 0;
      lastTranscript = '';
    };

    // Pick the best supported recording mime, preferring m4a (mp4) and
    // gracefully degrading to webm. Chromium historically lacks audio/mp4
    // support, so探测 is mandatory rather than hard-coding.
    const pickRecordingMime = (): string => {
      const candidates = [
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/webm;codecs=opus',
        'audio/webm',
      ];
      for (const t of candidates) {
        try {
          if (MediaRecorder.isTypeSupported(t)) return t;
        } catch { /* keep probing */ }
      }
      return ''; // let the UA decide
    };

    const drawWaveform = () => {
      if (!analyser || !recCanvas) {
        rafId = null;
        return;
      }
      const ctx2d = recCanvas.getContext('2d');
      if (!ctx2d) {
        rafId = null;
        return;
      }
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      const w = recCanvas.width;
      const h = recCanvas.height;
      ctx2d.clearRect(0, 0, w, h);

      const stroke = getComputedStyle(recBar)
        .getPropertyValue('--jp-recording-stroke')
        .trim() || '#7c3aed';
      ctx2d.fillStyle = stroke;

      // Symmetric capsule bars mirrored around the horizontal mid-line.
      const barCount = 48;
      const gap = Math.max(1, w * 0.012);
      const barW = (w - gap * (barCount - 1)) / barCount;
      const mid = h / 2;
      const maxHalf = mid * 0.98; // let bars nearly touch the edges
      const minHalf = Math.max(1, h * 0.05); // baseline so bars always read
      const samplesPerBar = buf.length / barCount;
      const r = barW / 2; // fully rounded → capsule
      // Per-bar smoothing state, created once and reused across frames.
      if (!(drawWaveform as any)._smooth) {
        (drawWaveform as any)._smooth = new Float32Array(barCount);
      }
      const smooth = (drawWaveform as any)._smooth as Float32Array;
      const gain = 2.4; // amplify raw mic level (typically 0.1–0.3)

      for (let i = 0; i < barCount; i++) {
        // Peak amplitude in this bar's slice of samples.
        let peak = 0;
        const start = Math.floor(i * samplesPerBar);
        const end = Math.floor((i + 1) * samplesPerBar);
        for (let j = start; j < end; j++) {
          const v = Math.abs(buf[j] - 128) / 128; // 0..1
          if (v > peak) peak = v;
        }
        // Non-linear expansion so quiet speech still moves the bars visibly:
        // gain → clamp → sqrt curve lifts the lower end.
        const expanded = Math.sqrt(Math.min(1, peak * gain));
        // Smooth toward the new value to avoid jitter (attack/release).
        const prev = smooth[i];
        const target = expanded > prev ? expanded : prev * 0.82 + expanded * 0.18;
        smooth[i] = target;
        const half = Math.max(minHalf, target * maxHalf);
        const x = i * (barW + gap);
        // Top + bottom mirrored capsules.
        if (typeof ctx2d.roundRect === 'function') {
          ctx2d.beginPath();
          ctx2d.roundRect(x, mid - half, barW, half, r);
          ctx2d.fill();
          ctx2d.beginPath();
          ctx2d.roundRect(x, mid, barW, half, r);
          ctx2d.fill();
        } else {
          ctx2d.fillRect(x, mid - half, barW, half);
          ctx2d.fillRect(x, mid, barW, half);
        }
      }

      recTime.setText(formatDuration(performance.now() - recordStartedAt));
      rafId = requestAnimationFrame(drawWaveform);
    };

    const stopRecording = async () => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
      // Freeze the live UI immediately so the waveform/duration stop the
      // moment the user clicks stop — don't wait for onstop or network.
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (realtimeTimer !== null) {
        window.clearInterval(realtimeTimer);
        realtimeTimer = null;
      }
      if (realtimeProcessor) {
        try { realtimeProcessor.disconnect(); } catch { /* noop */ }
        realtimeProcessor = null;
      }
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
      if (recordingTimeout !== null) {
        window.clearTimeout(recordingTimeout);
        recordingTimeout = null;
      }
    };

    const sttConfigured = () => {
      const s = this.plugin.settings;
      return s.sttEndpoint.trim().length > 0 && s.sttApiKey.trim().length > 0;
    };

    const wantRealtime = () => sttConfigured() && this.plugin.settings.sttRealtime;

    // Append streamed text right after the streaming cursor, keeping the
    // caret at the end so the next chunk lands next to it.
    const appendStreamedText = (text: string) => {
      const ta = this.textareaEl;
      const pos = realtimeBaseCursor;
      const before = ta.value.substring(0, pos);
      const after = ta.value.substring(pos);
      ta.value = before + text + after;
      realtimeBaseCursor = pos + text.length;
      ta.setSelectionRange(realtimeBaseCursor, realtimeBaseCursor);
      this.refreshSubmitState();
      this.autoResizeTextarea();
    };

    // Encode captured Float32 PCM frames into a standalone 16-bit PCM WAV
    // blob — independently decodable, so every chunk transcribes on its own.
    const encodeWav = (frames: Float32Array[], sampleRate: number): Blob => {
      const total = frames.reduce((n, f) => n + f.length, 0);
      if (total === 0) return new Blob([], { type: 'audio/wav' });
      const buffer = new ArrayBuffer(44 + total * 2);
      const view = new DataView(buffer);
      const writeStr = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
      };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + total * 2, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);          // PCM
      view.setUint16(22, 1, true);          // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, total * 2, true);
      let off = 44;
      for (const frame of frames) {
        for (let i = 0; i < frame.length; i++) {
          let s = Math.max(-1, Math.min(1, frame[i]));
          view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          off += 2;
        }
      }
      return new Blob([buffer], { type: 'audio/wav' });
    };

    // RMS energy of a PCM frame → drives voice-activity detection.
    const frameRms = (frame: Float32Array): number => {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      return Math.sqrt(sum / frame.length);
    };

    // Transcribe one VAD segment with the previous segment's trailing text as
    // `prompt` context, then append the result. Serialized so segments are
    // sent in order even if transcription outpaces real time.
    const transcribeSegment = (frames: Float32Array[], sr: number) => {
      pendingFlush = pendingFlush.then(async () => {
        const wav = encodeWav(frames, sr);
        if (wav.size < 4000) return; // too short → unstable transcript, skip
        try {
          // Feed the tail of the prior transcript as context so cross-segment
          // homophones / word-boundary carryover resolve correctly.
          const promptText = lastTranscript.slice(-64);
          const t = (await this.transcribeAudio(wav, promptText)).trim();
          if (t.length > 0) {
            appendStreamedText(t);
            lastTranscript = (lastTranscript + t).slice(-256);
          }
        } catch {
          // A failed segment shouldn't kill the live session — drop and continue.
        }
      });
    };

    // Flush whatever is currently accumulated in the segment buffer. Used both
    // by the max-length force-cut and by the final flush on stop.
    const flushCurrentSegment = () => {
      if (!audioCtx) return;
      if (segmentFrames.length === 0) return;
      const sr = audioCtx.sampleRate;
      const seg = segmentFrames;
      segmentFrames = [];
      vadSegmentSamples = 0;
      vadSilenceSamples = 0;
      if (seg.reduce((n, f) => n + f.length, 0) / sr < VAD_MIN_SEG_SAMPLES) return;
      vadFirstSegment = false;
      void transcribeSegment(seg, sr);
    };

    // Inspect an incoming PCM frame for voice activity; either accumulate it
    // into the current segment or cut at a silence boundary and transcribe.
    const ingestFrame = (frame: Float32Array) => {
      if (!audioCtx) return;
      const sr = audioCtx.sampleRate;
      segmentFrames.push(new Float32Array(frame));
      vadSegmentSamples += frame.length;

      const silent = frameRms(frame) < VAD_ENERGY_RMS;
      vadSilenceSamples = silent ? vadSilenceSamples + frame.length : 0;

      // Cut after a pause (natural phrase boundary) — best accuracy per send.
      if (vadSilenceSamples >= VAD_SILENCE_CUT_SAMPLES * sr
          && vadSegmentSamples >= VAD_MIN_SEG_SAMPLES * sr) {
        flushCurrentSegment();
        return;
      }
      // First segment flushes early (before any pause) so the user sees the
      // first words quickly instead of waiting for a silence boundary.
      if (vadFirstSegment && vadSegmentSamples >= VAD_FIRST_FLUSH_SAMPLES * sr) {
        flushCurrentSegment();
        return;
      }
      // Force-cut overly long segments so latency stays bounded.
      if (vadSegmentSamples >= VAD_MAX_SEG_SAMPLES * sr) {
        flushCurrentSegment();
      }
    };

    const insertAtCursor = (text: string) => {
      const textarea = this.textareaEl;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = textarea.value.substring(0, start);
      const after = textarea.value.substring(end);
      const piece = text + ' ';
      textarea.value = before + piece + after;
      const newPos = start + piece.length;
      textarea.setSelectionRange(newPos, newPos);
      this.refreshSubmitState();
      this.autoResizeTextarea();
    };

    const startRecording = async () => {
      if (this.pendingImages.length > 0) {
        notice(t('notice.imageAddedNoRecording'));
        return;
      }
      if (this.pendingAudio.length >= JournalCaptureView.MAX_PENDING_AUDIO) {
        notice(t('notice.maxOneRecording'));
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        const mime = pickRecordingMime();
        mediaRecorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
        const outType = mime.startsWith('audio/mp4') ? 'audio/mp4' : 'audio/webm';

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          // Flush the tail segment and snapshot the in-flight chain BEFORE
          // any await. We must insert the audio embed *after* every queued
          // segment's `appendStreamedText` has run, otherwise a slow final
          // segment would land AFTER the embed (re-ordering the text).
          //
          // We capture `pendingFlush` here and await it (no timeout race) so
          // the chain fully drains. The waveform is torn down immediately so
          // the UI doesn't appear stuck; only the final text append waits on
          // the network. A genuinely-hung segment is rare; if it happens the
          // user can reload the plugin and the text already on screen is kept.
          if (realtimeActive && audioCtx) flushCurrentSegment();
          const flushChain = pendingFlush;
          const duration = formatDuration(performance.now() - recordStartedAt);
          teardownAnalyser();
          const audioBlob = new Blob(audioChunks, { type: outType });
          const wantSTT = sttConfigured();
          // Keep the recBar visible with a breathing effect while we finish
          // the final transcription. The stop button is hidden (recording
          // already stopped) and the icon group + NOTE button stay hidden
          // until the final text has landed (so the user sees the result
          // appear together with the action buttons coming back).
          recStatus.setText(t('capture.transcribing'));
          recBar.addClass('is-transcribing');
          recBar.style.display = '';
          try {
            const audioFile = await this.saveAudioToVault(audioBlob);
            let text = '';
            // In realtime mode, keep the streamed draft as-is (faster, no
            // extra API call). In non-realtime mode, transcribe the full
            // recording now. Either way, the audio itself becomes a pending
            // attachment (like images) instead of an inline embed link —
            // only the transcript text lands in the textarea.
            if (!realtimeActive && wantSTT) {
              try {
                text = (await this.transcribeAudio(audioBlob)).trim();
              } catch (err) {
                notice(t('notice.transcribeFailed', { error: err instanceof Error ? err.message : String(err) }));
              }
            }
            // Drain any still-in-flight live segments before we touch the
            // text again, so the transcript is fully settled before we hand
            // control back to the user.
            await flushChain;
            if (!realtimeActive && text.length > 0) {
              insertAtCursor(text);
            }
            this.addPendingAudio(audioFile, duration);
          } catch (err) {
            notice(t('notice.recordingSaveFailed', { error: err instanceof Error ? err.message : String(err) }));
          } finally {
            // RecBar fades out and the action bar (icon group + NOTE button)
            // comes back together — the user sees the result and the controls
            // to act on it arrive in the same beat.
            recBar.removeClass('is-transcribing');
            recBar.removeClass('jp-bar-entering');
            recBar.style.display = 'none';
            actions.removeClass('is-recording');
          }
        };

        mediaRecorder.start();

        // Decide live-streaming for this session.
        realtimeActive = wantRealtime();

        // Wire up the live waveform + duration. Do NOT connect analyser to
        // destination — that would route mic back to speakers and cause feedback.
        try {
          const Ctor = window.AudioContext || (window as any).webkitAudioContext;
          audioCtx = new Ctor();
          const source = audioCtx.createMediaStreamSource(stream);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);

          // Realtime capture: tap the same source via a ScriptProcessor and
          // segment by voice activity (silence boundaries) for transcription.
          if (realtimeActive) {
            realtimeRegionStart = this.textareaEl.selectionStart;
            realtimeBaseCursor = realtimeRegionStart;
            lastTranscript = '';
            segmentFrames = [];
            vadSilenceSamples = 0;
            vadSegmentSamples = 0;
            vadFirstSegment = true;
            const sp = audioCtx.createScriptProcessor(VAD_FRAME, 1, 1);
            sp.onaudioprocess = (ev: AudioProcessingEvent) => {
              ingestFrame(ev.inputBuffer.getChannelData(0));
            };
            source.connect(sp);
            // ScriptProcessor must connect somewhere to fire; analyser suffices.
            sp.connect(analyser);
            realtimeProcessor = sp;
          }

          // Reveal the bar FIRST, then measure — reading clientWidth while
          // display:none returns 0 and the canvas ends up 1px wide (invisible).
          // The `jp-bar-entering` class triggers a one-shot fade+slide
          // animation; we remove it after hide so the next show replays it.
          recStatus.setText(realtimeActive ? t('capture.realtimeTranscribing') : t('capture.recording'));
          recBar.style.display = '';
          recBar.addClass('jp-bar-entering');
          const dpr = window.devicePixelRatio || 1;
          recCanvas.width = Math.max(1, recCanvas.clientWidth) * dpr;
          recCanvas.height = Math.max(1, recCanvas.clientHeight) * dpr;
          recordStartedAt = performance.now();
          rafId = requestAnimationFrame(drawWaveform);
        } catch {
          // Analyser/realtime are optional — recording still works without them.
        }

        // Trigger the focus-recording mode (icon group + submit collapse) at
        // the same time as the recBar reveal so the two animations overlap
        // and feel like a single transition rather than a sequence.
        actions.addClass('is-recording');

        recordingTimeout = window.setTimeout(() => {
          void stopRecording();
          notice(t('notice.recordingAutoStopped'));
        }, 5 * 60 * 1000);
      } catch (err) {
        notice(t('notice.micAccessFailed', { error: err instanceof Error ? err.message : String(err) }));
      }
    };

    // Expose to beginRecording() so the URL handler can trigger recording.
    this.startRecordingFn = startRecording;

    const actions = this.inputCardEl.createDiv({ cls: 'jp-capture-actions' });

    // Left side: icon-button pill + pending-image thumbnails, grouped so
    // `justify-content: space-between` on `actions` only splits this group
    // from the submit button.
    const leftGroup = actions.createDiv({ cls: 'jp-capture-left-group' });

    // Single "+" button — opens a dropdown to choose image upload or
    // recording, instead of showing both as separate icon buttons.
    const buttonRow = leftGroup.createDiv({ cls: 'jp-capture-button-row' });

    const plusBtn = buttonRow.createEl('button', {
      cls: 'jp-capture-plus-btn',
      attr: { 'aria-label': t('capture.add') },
    });
    setIcon(plusBtn, 'plus');

    // "#" button — inserts a literal "#" at the cursor, same as pressing the
    // key, so Obsidian's own tag-suggestion popup can pick it up without the
    // user reaching for the keyboard.
    const tagBtn = buttonRow.createEl('button', {
      cls: 'jp-capture-tag-btn',
      text: '#',
      attr: { 'aria-label': t('capture.addTag') },
    });
    tagBtn.addEventListener('click', () => {
      const textarea = this.textareaEl;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = textarea.value.substring(0, start);
      const after = textarea.value.substring(end);
      textarea.focus();
      textarea.value = before + '#' + after;
      const newPos = start + 1;
      textarea.setSelectionRange(newPos, newPos);
      textarea.dispatchEvent(new Event('input'));
    });

    // "@" button — inserts a literal "@" at the cursor to trigger the
    // note-mention popup below, which inserts an Obsidian-recognized
    // `[[wikilink]]` to the chosen file.
    const mentionBtn = buttonRow.createEl('button', {
      cls: 'jp-capture-mention-btn',
      text: '@',
      attr: { 'aria-label': t('capture.addMention') },
    });
    mentionBtn.addEventListener('click', () => {
      const textarea = this.textareaEl;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = textarea.value.substring(0, start);
      const after = textarea.value.substring(end);
      textarea.focus();
      textarea.value = before + '@' + after;
      const newPos = start + 1;
      textarea.setSelectionRange(newPos, newPos);
      textarea.dispatchEvent(new Event('input'));
    });

    // "📍" button — grabs the current GPS coordinate via the browser
    // Geolocation API, reverse-geocodes it, and drops the result into
    // `pendingLocation` (same pill / same submit path as the EXIF flow).
    // Mobile only: on Obsidian desktop, `navigator.geolocation` silently
    // times out because Electron ships no Google Geolocation API key, so
    // exposing the button there is worse than useless.
    if (Platform.isMobile) {
      const geoBtn = buttonRow.createEl('button', {
        cls: 'jp-capture-geo-btn',
        attr: { 'aria-label': t('capture.addLocation') },
      });
      setIcon(geoBtn, 'map-pin');
      geoBtn.addEventListener('click', () => {
        void this.pickCurrentLocation(geoBtn);
      });
      this.geoBtnEl = geoBtn;
    }

    // Shared stop path: stop recording + restore the idle UI (icon group,
    // submit button) with a smooth transition. The actual text insert /
    // transcription runs async in onstop, independent of this UI restore.
    //
    // We deliberately keep `actions.is-recording` set here so the icon group
    // and NOTE button stay hidden until the final text has been written. The
    // recBar is switched to its "transcribing" state by onstop, and only
    // removed from .is-recording once the last segment has landed.
    const doStop = async () => {
      await stopRecording();
    };

    plusBtn.addEventListener('click', (evt: MouseEvent) => {
      // Images and audio are mutually exclusive per entry — once one kind
      // has a pending attachment, the other option is grayed out. Images
      // additionally gray out once the 4-image cap is reached.
      const hasAudio = this.pendingAudio.length > 0;
      const hasImages = this.pendingImages.length > 0;
      const imageMaxedOut = this.pendingImages.length >= JournalCaptureView.MAX_PENDING_IMAGES;
      const audioMaxedOut = this.pendingAudio.length >= JournalCaptureView.MAX_PENDING_AUDIO;
      const imageDisabled = hasAudio || imageMaxedOut;
      const micDisabled = hasImages || audioMaxedOut;

      const menu = new Menu();
      menu.addItem(item => item
        .setTitle(t('capture.uploadImage', { max: String(JournalCaptureView.MAX_PENDING_IMAGES) }))
        .setIcon('image')
        .setDisabled(imageDisabled)
        .onClick(() => {
          if (imageDisabled) return;
          fileInput.click();
        }));
      menu.addItem(item => item
        .setTitle(t('capture.recordAudio'))
        .setIcon('mic')
        .setDisabled(micDisabled)
        .onClick(async () => {
          if (micDisabled) return;
          if (!mediaRecorder || mediaRecorder.state === 'inactive') {
            await startRecording();
          } else {
            await doStop();
          }
        }));
      menu.showAtMouseEvent(evt);
    });

    // Stop button centered under the waveform.
    recStopBtn.addEventListener('click', () => void doStop());

    // Capture-time override pill — shown once the user opts into using an
    // image's capture time instead of "now". Removable, since the user may
    // change their mind before submit. Rendered in the top pill row above
    // the textarea so all pending-entry context lives in one place.
    this.captureTimePillEl = this.topPillRowEl.createDiv({ cls: 'jp-capture-time-pill jp-capture-time-pill--hidden' });

    // Location override pill — shown once a photo's EXIF GPS coordinate has
    // been detected (or the user tapped 📍 on mobile). Removable, same as
    // the capture-time pill.
    this.locationPillEl = this.topPillRowEl.createDiv({ cls: 'jp-capture-time-pill jp-location-pill--hidden' });

    // "Apply photo info?" hint pill — shown after the confirm modal was
    // declined/dismissed but the photo still carries detected time/location,
    // so an accidental dismiss (misclick while several photos were still
    // processing) doesn't lose the offer permanently.
    this.metadataHintPillEl = this.topPillRowEl.createDiv({ cls: 'jp-capture-time-pill jp-location-pill--hidden' });

    this.submitBtn = actions.createEl('button', {
      cls: 'jp-capture-submit',
      attr: { 'aria-label': t('capture.submit') },
    });
    setIcon(this.submitBtn, 'arrow-up');
    this.submitBtn.addEventListener('click', () => {
      void this.handleSubmit();
    });

    this.refreshSubmitState();
    this.renderCaptureTimePill();
    this.renderLocationPill();
    this.renderMetadataHintPill();
    this.renderEditingPill();
  }

  /**
   * Resolve the full vault path to save an attachment at.
   *
   * - No configured folder → defer entirely to Obsidian's
   *   `getAvailablePathForAttachment`: it reads the real "Files & links →
   *   Default location for new attachments" setting (`attachmentFolderPath`,
   *   NOT the new-file setting), honours the `.` (same folder as note) and
   *   `/` (vault root) special values, creates the parent dir, and de-dupes.
   * - Configured folder (or `/` for vault root) → de-dupe the base name
   *   against THAT folder and ensure it exists. `getAvailablePathForAttachment`
   *   can't be reused here: it de-dupes against the *attachment*-setting
   *   folder, so when the two differ the suffix would be wrong — it would
   *   skip a name that collides in our folder, or append one needlessly.
   *
   * Note: `FileManager.getNewFileParent` reads the *new-note* location
   * (`newFileLocation` / `newFileFolderPath`), a different setting from the
   * attachment folder — using it here was a bug that landed files in the
   * new-note folder instead of the attachment folder.
   */
  private async resolveAttachmentPath(configuredFolder: string, baseName: string): Promise<string> {
    const configured = configuredFolder.trim();
    if (configured.length === 0) {
      const todayNote = getDailyNote(moment(), getAllDailyNotes()) as TFile | null;
      const sourcePath = todayNote?.path ?? '';
      return this.app.fileManager.getAvailablePathForAttachment(baseName, sourcePath);
    }
    // User-configured folder (`/` → vault root). De-dupe against it directly.
    const folder = configured === '/' ? '' : configured;
    const prefix = folder ? `${folder}/` : '';
    let candidate = `${prefix}${baseName}`;
    if (this.app.vault.getAbstractFileByPath(candidate)) {
      const dot = baseName.lastIndexOf('.');
      const stem = dot === -1 ? baseName : baseName.slice(0, dot);
      const ext = dot === -1 ? '' : baseName.slice(dot);
      let n = 1;
      candidate = `${prefix}${stem} ${n}${ext}`;
      while (this.app.vault.getAbstractFileByPath(candidate)) {
        n++;
        candidate = `${prefix}${stem} ${n}${ext}`;
      }
    }
    await this.ensureAttachmentFolder(folder);
    return candidate;
  }

  /**
   * Create `folder` and any missing parents. `vault.createFolder` only
   * creates a single level, so a nested configured path like `Assets/Audio`
   * would fail if `Assets` doesn't exist yet. No-op for empty (vault root).
   */
  private async ensureAttachmentFolder(folder: string): Promise<void> {
    if (!folder) return;
    let current = '';
    for (const part of folder.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async saveImageToVault(blob: Blob): Promise<TFile> {
    const ext = blob.type === 'image/png' ? 'png'
      : blob.type === 'image/gif' ? 'gif'
      : blob.type === 'image/webp' ? 'webp'
      : blob.type === 'image/jpeg' ? 'jpg' : 'png';
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const baseName = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
    const filePath = await this.resolveAttachmentPath(this.plugin.settings.imageFolder, baseName);
    const buffer = await blob.arrayBuffer();
    return this.app.vault.createBinary(filePath, buffer);
  }

  /** Adds a saved image to the pending-attachments strip (not the text body). */
  private addPendingImage(file: TFile) {
    this.pendingImages.push(file);
    this.renderAttachmentList();
    this.refreshSubmitState();
  }

  /** Re-renders the attachment strip from `pendingImages` and `pendingAudio`. */
  private renderAttachmentList() {
    this.attachmentListEl.empty();
    const isEmpty = this.pendingImages.length === 0 && this.pendingAudio.length === 0;
    this.attachmentListEl.toggleClass('jp-capture-attachments--empty', isEmpty);

    if (this.pendingImages.length > 0) {
      // Plain horizontal row of thumbnails — the grid layout is for the
      // submitted timeline entry, not this pending preview.
      const grid = this.attachmentListEl.createDiv({ cls: 'jp-capture-image-grid' });
      for (const file of this.pendingImages) {
        const thumb = grid.createDiv({ cls: 'jp-capture-attachment-thumb' });
        const imgWrap = thumb.createDiv({ cls: 'jp-capture-attachment-thumb-img' });
        const src = this.app.vault.getResourcePath(file);
        const img = imgWrap.createEl('img', { attr: { src } });
        img.alt = file.name;
        imgWrap.addEventListener('click', () => {
          new ImagePreviewModal(this.app, src, file.name).open();
        });
        const removeBtn = thumb.createEl('button', {
          cls: 'jp-capture-attachment-remove',
          attr: { 'aria-label': t('capture.removeImage') },
        });
        setIcon(removeBtn, 'x');
        removeBtn.addEventListener('click', () => {
          this.pendingImages = this.pendingImages.filter(f => f !== file);
          this.renderAttachmentList();
          this.refreshSubmitState();
          if (this.pendingImages.length === 0) {
            this.pendingCaptureOverride = null;
            this.pendingLocation = null;
            this.pendingMetadataHint = null;
            this.lastAppliedMetadata = null;
            this.renderCaptureTimePill();
            this.renderLocationPill();
            this.renderMetadataHintPill();
          }
        });
      }
    }

    for (const audio of this.pendingAudio) {
      const card = this.attachmentListEl.createDiv({ cls: 'jp-capture-attachment-audio' });
      const iconEl = card.createSpan({ cls: 'jp-capture-attachment-audio-icon' });
      setIcon(iconEl, 'mic');
      card.createSpan({ cls: 'jp-capture-attachment-audio-duration', text: audio.duration });
      const removeBtn = card.createEl('button', {
        cls: 'jp-capture-attachment-remove',
        attr: { 'aria-label': t('capture.removeAudio') },
      });
      setIcon(removeBtn, 'x');
      removeBtn.addEventListener('click', async () => {
        this.pendingAudio = this.pendingAudio.filter(a => a !== audio);
        this.renderAttachmentList();
        this.refreshSubmitState();
        try {
          await this.app.fileManager.trashFile(audio.file);
        } catch (err) {
          console.error('[Spark Memo] trash pending audio failed', err);
        }
      });
    }
  }

  /**
   * Shows/hides the capture-time override pill next to the image/mic
   * buttons. Visible only while `pendingCaptureOverride` is set; clicking
   * its × reverts to recording with the current time.
   */
  private renderCaptureTimePill() {
    this.captureTimePillEl.empty();
    const override = this.pendingCaptureOverride;
    this.captureTimePillEl.toggleClass('jp-capture-time-pill--hidden', !override);
    if (!override) return;

    const iconEl = this.captureTimePillEl.createSpan({ cls: 'jp-capture-time-pill-icon' });
    setIcon(iconEl, 'clock');
    const label = override.date.isSame(moment(), 'day')
      ? override.time
      : `${override.date.format('MM-DD')} ${override.time}`;
    this.captureTimePillEl.createSpan({ cls: 'jp-capture-time-pill-text', text: label });

    const clearBtn = this.captureTimePillEl.createEl('button', {
      cls: 'jp-capture-time-pill-clear',
      attr: { 'aria-label': t('capture.revertToNow') },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('click', () => {
      this.pendingCaptureOverride = null;
      this.renderCaptureTimePill();
      notice(t('notice.revertedToNow'));
      this.maybeRestoreMetadataHintAfterClear();
    });
  }

  /**
   * Shows/hides the location override pill next to the capture-time pill.
   * Visible only while `pendingLocation` is set; shows "locating…" while the
   * reverse-geocode request is still in flight. Clicking × removes it.
   */
  private renderLocationPill() {
    this.locationPillEl.empty();
    const loc = this.pendingLocation;
    this.locationPillEl.toggleClass('jp-location-pill--hidden', !loc);
    // Keep the 📍 button in sync: disabled while a location is already
    // pending, so the user can't accidentally overwrite it — they have to
    // clear the existing pill first.
    if (this.geoBtnEl) {
      this.geoBtnEl.disabled = !!loc;
      this.geoBtnEl.toggleClass('is-disabled', !!loc);
    }
    if (!loc) return;

    const iconEl = this.locationPillEl.createSpan({ cls: 'jp-capture-time-pill-icon' });
    setIcon(iconEl, 'map-pin');
    const label = loc.name ?? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
    this.locationPillEl.createSpan({ cls: 'jp-capture-time-pill-text', text: label });

    // Reverse geocoding failed (network error, etc.) — show the raw
    // coordinate and let the user retry without having to remove/re-add
    // the photo.
    if (loc.name === null) {
      const retryBtn = this.locationPillEl.createEl('button', {
        cls: 'jp-capture-time-pill-clear',
        attr: { 'aria-label': t('location.retryGeocode') },
      });
      setIcon(retryBtn, 'refresh-cw');
      retryBtn.addEventListener('click', () => void this.retryLocationName());
    }

    const clearBtn = this.locationPillEl.createEl('button', {
      cls: 'jp-capture-time-pill-clear',
      attr: { 'aria-label': t('location.remove') },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('click', () => {
      this.pendingLocation = null;
      this.renderLocationPill();
      this.maybeRestoreMetadataHintAfterClear();
    });
  }

  /**
   * After clearing an applied capture-time or location pill, brings the
   * "apply photo info?" hint back if *both* pills are now gone and we still
   * remember what was applied — otherwise removing them would silently lose
   * the offer instead of letting the user bring it back. Applies whether
   * composing a new entry or editing an existing one.
   */
  private maybeRestoreMetadataHintAfterClear(): void {
    if (this.pendingCaptureOverride || this.pendingLocation) return;
    if (!this.lastAppliedMetadata) return;
    this.pendingMetadataHint = this.lastAppliedMetadata;
    this.lastAppliedMetadata = null;
    this.renderMetadataHintPill();
  }

  /**
   * Shows/hides the "apply photo info?" hint pill. Visible only while
   * `pendingMetadataHint` is set — i.e. the confirm modal was declined or
   * dismissed while metadata was actually detected. Clicking the label
   * re-opens the same confirm modal; clicking × dismisses the hint for
   * good (same as declining again).
   */
  private renderMetadataHintPill() {
    this.metadataHintPillEl.empty();
    const hint = this.pendingMetadataHint;
    this.metadataHintPillEl.toggleClass('jp-location-pill--hidden', !hint);
    if (!hint) return;

    const iconEl = this.metadataHintPillEl.createSpan({ cls: 'jp-capture-time-pill-icon' });
    setIcon(iconEl, 'sparkles');
    const label = this.metadataHintPillEl.createSpan({
      cls: 'jp-capture-time-pill-text jp-metadata-hint-text',
      text: t('capture.metadataHintLabel'),
    });
    label.addEventListener('click', () => void this.reapplyMetadataHint());

    const clearBtn = this.metadataHintPillEl.createEl('button', {
      cls: 'jp-capture-time-pill-clear',
      attr: { 'aria-label': t('capture.metadataHintDismiss') },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('click', () => {
      this.pendingMetadataHint = null;
      this.lastAppliedMetadata = null;
      this.renderMetadataHintPill();
    });
  }

  /** Re-opens the confirm modal from a dismissed hint, using the metadata already detected — no re-reading the photo files. */
  private async reapplyMetadataHint(): Promise<void> {
    const hint = this.pendingMetadataHint;
    if (!hint) return;
    this.pendingMetadataHint = null;
    this.renderMetadataHintPill();
    await this.confirmAndApplyMetadata(hint.capturedAt, hint.diffMinutes, hint.gpsCoord);
  }

  /**
   * Grabs the device's current GPS coordinate and turns it into a pending
   * location pill, same shape as the EXIF-driven flow. Reverse geocoding
   * runs after the pill appears so the user isn't blocked on it — the pill
   * shows "locating…" until the name resolves (or a retry button on failure).
   */
  private async pickCurrentLocation(btn: HTMLButtonElement): Promise<void> {
    if (!('geolocation' in navigator)) {
      notice(t('notice.geolocationUnsupported'));
      return;
    }
    if (btn.hasClass('is-loading')) return;
    btn.addClass('is-loading');
    btn.disabled = true;
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 30000,
        });
      });
      const latitude = pos.coords.latitude;
      const longitude = pos.coords.longitude;
      this.pendingLocation = { latitude, longitude, name: null };
      this.renderLocationPill();
      const name = await reverseGeocodeCity(latitude, longitude);
      if (
        this.pendingLocation &&
        this.pendingLocation.latitude === latitude &&
        this.pendingLocation.longitude === longitude
      ) {
        this.pendingLocation.name = name;
        this.renderLocationPill();
        if (name === null) notice(t('notice.geocodeFailedCoordOnly'));
      }
    } catch (err) {
      const msg = err instanceof GeolocationPositionError
        ? err.message || String(err.code)
        : err instanceof Error ? err.message : String(err);
      notice(t('notice.geolocationFailed', { error: msg }));
    } finally {
      btn.removeClass('is-loading');
      btn.disabled = false;
    }
  }

  /** Re-runs reverse geocoding for the pending location's coordinate. */
  private async retryLocationName(): Promise<void> {
    const loc = this.pendingLocation;
    if (!loc) return;
    const name = await reverseGeocodeCity(loc.latitude, loc.longitude);
    // The pill may have been cleared, or replaced by a different photo's
    // coordinate, while this request was in flight.
    if (
      this.pendingLocation &&
      this.pendingLocation.latitude === loc.latitude &&
      this.pendingLocation.longitude === loc.longitude
    ) {
      this.pendingLocation.name = name;
      this.renderLocationPill();
      if (name === null) notice(t('notice.geocodeFailedCoordOnly'));
    }
  }

  /** Shows/hides the "editing" pill next to the location pill. */
  private renderEditingPill() {
    this.editingPillEl.empty();
    const editing = !!this.editingEntry;
    this.editingPillEl.toggleClass('jp-location-pill--hidden', !editing);
    if (!editing) return;

    const iconEl = this.editingPillEl.createSpan({ cls: 'jp-capture-time-pill-icon' });
    setIcon(iconEl, 'pencil');
    this.editingPillEl.createSpan({ cls: 'jp-capture-time-pill-text', text: t('capture.editing') });

    const clearBtn = this.editingPillEl.createEl('button', {
      cls: 'jp-capture-time-pill-clear',
      attr: { 'aria-label': t('capture.cancelEdit') },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('click', () => this.cancelEdit());
  }

  /**
   * Loads an existing entry's text back into the input box for editing —
   * triggered from the entry's context menu "编辑" item. Submitting while in
   * this state rewrites the entry in place (see `handleSubmit`) instead of
   * appending a new one.
   *
   * Embedded images/audio and the location tag aren't dumped into the
   * textarea as raw `![[...]]`/`[name](geo:...)` text — they're pulled back
   * out into `pendingImages` / `pendingAudio` / `pendingLocation` so they
   * render as the same attachment previews / pills used when composing a
   * new entry. `handleSubmit` already rebuilds the raw body from those on
   * save, so this round-trips cleanly.
   */
  private async startEdit(day: DaySection, entry: JournalEntry): Promise<void> {
    if (this.currentTab !== 'capture') this.switchTab('capture');
    this.editingEntry = { day, entry };
    // The metadata hint pill is new-entry-only — an edit shouldn't offer to
    // apply a *different* photo batch's leftover time/location.
    this.pendingMetadataHint = null;
    this.lastAppliedMetadata = null;
    this.renderMetadataHintPill();
    // Leftover from a previous entry's photo-time confirmation shouldn't
    // silently carry into this edit.
    this.pendingCaptureOverride = null;
    this.renderCaptureTimePill();

    const { text: textWithoutLocation, location } = extractLocationTag(entry.text);
    const audioPaths = extractAudioEmbeds(textWithoutLocation);
    const imagePaths = extractImageEmbeds(textWithoutLocation);

    this.textareaEl.value = stripAttachmentEmbeds(textWithoutLocation);
    this.pendingLocation = location
      ? { latitude: location.latitude, longitude: location.longitude, name: location.name }
      : null;

    const imageFiles = imagePaths
      .map(p => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile);
    this.pendingImages = imageFiles;

    this.pendingAudio = [];
    const audioFile = audioPaths
      .map(p => this.app.vault.getAbstractFileByPath(p))
      .find((f): f is TFile => f instanceof TFile);
    if (audioFile) {
      const duration = await this.readAudioDuration(audioFile);
      // Bail if the edit was cancelled (or moved to a different entry)
      // while we were probing the audio file's duration.
      if (this.editingEntry?.entry !== entry) return;
      this.pendingAudio = [{ file: audioFile, duration }];
    }

    const missingCount = (audioPaths.length - (audioFile ? 1 : 0)) + (imagePaths.length - imageFiles.length);
    if (missingCount > 0) {
      notice(t('notice.attachmentsMissing', { count: String(missingCount) }));
    }

    this.textareaEl.focus();
    this.autoResizeTextarea();
    this.renderAttachmentList();
    this.renderLocationPill();
    this.renderEditingPill();
    this.refreshSubmitState();
    // Input card sits at the top of the scroller, timeline below it — scroll
    // up so the user lands on the input box, not down into old entries.
    const scroller = this.containerEl.children[1] as HTMLElement;
    scroller.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Discards the in-progress edit and clears the input box + attachments. */
  private cancelEdit() {
    this.editingEntry = null;
    this.textareaEl.value = '';
    this.textareaEl.placeholder = this.pickRandomPlaceholder();
    this.pendingImages = [];
    this.pendingAudio = [];
    this.pendingLocation = null;
    this.pendingMetadataHint = null;
    this.lastAppliedMetadata = null;
    this.autoResizeTextarea();
    this.renderAttachmentList();
    this.renderLocationPill();
    this.renderMetadataHintPill();
    this.renderEditingPill();
    this.refreshSubmitState();
  }

  /**
   * Renders a location pill next to an already-submitted entry's timestamp
   * — same visual style as the composer's pending-location pill. Clicking
   * it opens the coordinate in Apple Maps (`maps://`), matching sparkflow's
   * location-chip behaviour.
   *
   * If the name is still the "位置" placeholder (reverse geocoding failed
   * at submit time), also shows a "重试" button that re-geocodes and
   * rewrites the note's `[位置](geo:...)` tag in place on success.
   */
  private renderLocationChip(container: HTMLElement, day: DaySection, entry: JournalEntry, location: EntryLocation) {
    const chip = container.createEl('a', {
      cls: 'jp-capture-time-pill jp-location-chip',
      attr: { href: `maps://?ll=${location.latitude},${location.longitude}&q=${encodeURIComponent(location.name)}` },
    });
    const iconEl = chip.createSpan({ cls: 'jp-capture-time-pill-icon' });
    setIcon(iconEl, 'map-pin');
    chip.createSpan({ cls: 'jp-capture-time-pill-text', text: location.name });

    if (location.name !== t('location.placeholder')) return;

    const retryBtn = container.createEl('button', {
      cls: 'jp-capture-time-pill-clear',
      attr: { 'aria-label': t('location.retryGeocode') },
    });
    setIcon(retryBtn, 'refresh-cw');
    retryBtn.addEventListener('click', (evt: MouseEvent) => {
      evt.stopPropagation();
      void this.retryTimelineLocationName(day, entry, location, retryBtn);
    });
  }

  /**
   * Re-geocodes a submitted entry's location and, on success, rewrites its
   * `[位置](geo:lat,lon)` tag in place with the resolved name. `vault.modify`
   * triggers the plugin's own file-change handler, which re-renders the
   * affected day's section — so the pill updates without a manual refresh.
   */
  private async retryTimelineLocationName(
    day: DaySection,
    entry: JournalEntry,
    location: EntryLocation,
    retryBtn: HTMLButtonElement,
  ): Promise<void> {
    if (!day.filePath) return;
    const file = this.app.vault.getAbstractFileByPath(day.filePath);
    if (!(file instanceof TFile)) return;

    retryBtn.disabled = true;
    const name = await reverseGeocodeCity(location.latitude, location.longitude);
    if (!name) {
      retryBtn.disabled = false;
      notice(t('notice.geocodeFailedRetry'));
      return;
    }

    const content = await this.app.vault.read(file);
    const next = updateEntryLocationName(
      content,
      this.plugin.settings,
      entry.lineIndex,
      location.latitude,
      location.longitude,
      name,
    );
    if (next === content) {
      retryBtn.disabled = false;
      notice(t('notice.locationTagNotFound'));
      return;
    }
    await this.app.vault.modify(file, next);
    notice(t('notice.locationNameUpdated', { name }));
  }

  /**
   * Saves the picked/pasted/dropped image(s), adds them to the pending
   * strip (capped at `MAX_PENDING_IMAGES`), and — if enabled — checks the
   * *earliest* capture time across this batch against now.
   */
  private async addImageFiles(files: File[]): Promise<void> {
    if (this.pendingAudio.length > 0) {
      notice(t('notice.audioAddedNoImage'));
      return;
    }
    const room = JournalCaptureView.MAX_PENDING_IMAGES - this.pendingImages.length;
    if (room <= 0) {
      notice(t('notice.maxImages', { max: String(JournalCaptureView.MAX_PENDING_IMAGES) }));
      return;
    }
    const accepted = files.slice(0, room);
    if (files.length > accepted.length) {
      notice(t('notice.maxImagesIgnored', { max: String(JournalCaptureView.MAX_PENDING_IMAGES), ignored: String(files.length - accepted.length) }));
    }

    try {
      let originalTotal = 0;
      let compressedTotal = 0;
      let compressedCount = 0;
      for (const file of accepted) {
        const result = await this.maybeCompressImage(file);
        const saved = await this.saveImageToVault(result.blob);
        this.addPendingImage(saved);
        if (result.compressed) {
          compressedCount++;
          originalTotal += result.originalSize;
          compressedTotal += result.compressedSize;
        }
      }
      if (compressedCount > 0) {
        const savedPct = Math.round((1 - compressedTotal / originalTotal) * 100);
        notice(
          t('notice.imagesCompressed', {
            count: String(compressedCount),
            before: formatBytes(originalTotal),
            after: formatBytes(compressedTotal),
            pct: String(savedPct),
          }),
        );
      }
      // Capture-time/location check reads the *original* files —
      // compression can strip EXIF, but the original still carries it in
      // memory here.
      await this.maybeCheckImageMetadata(accepted);
    } catch (err) {
      notice(t('notice.imageSaveFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /**
   * Downscales/re-encodes an image before it's written to the vault, if
   * the "图片压缩" setting is on. GIFs are left untouched (canvas re-encoding
   * would flatten the animation to a single frame). Falls back to the
   * original file whenever compression isn't smaller or fails outright —
   * this is a size optimization, never something that should block a save.
   */
  private async maybeCompressImage(file: File): Promise<{ blob: Blob; compressed: boolean; originalSize: number; compressedSize: number }> {
    const settings = this.plugin.settings;
    const uncompressed = { blob: file as Blob, compressed: false, originalSize: file.size, compressedSize: file.size };
    if (!settings.imageCompressionEnabled) return uncompressed;
    if (file.type === 'image/gif') return uncompressed;

    try {
      const bitmap = await createImageBitmap(file);
      let { width, height } = bitmap;
      const maxSize = settings.imageCompressionMaxSize;
      if (maxSize > 0 && (width > maxSize || height > maxSize)) {
        const scale = maxSize / Math.max(width, height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return uncompressed;
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();

      // Everything (including PNG) re-encodes to lossy WebP via a bundled
      // WASM encoder (see webp-encoder.ts) rather than the browser's own
      // `canvas.toBlob('image/webp', ...)` — Safari/iOS can *decode* WebP
      // but has never implemented canvas *encoding* to it, so toBlob would
      // silently resolve `null` there. The WASM path works identically on
      // every platform, so iOS gets the same compression as desktop. WebP's
      // lossy mode still supports an alpha channel, so transparent PNGs
      // are preserved.
      let blob: Blob | null = null;
      let outType = 'image/webp';
      try {
        const imageData = ctx.getImageData(0, 0, width, height);
        const encoded = await encodeWebp(imageData, { quality: Math.round(settings.imageCompressionQuality * 100) });
        blob = new Blob([encoded], { type: 'image/webp' });
      } catch (err) {
        console.error('[Spark Memo] WASM WebP encode failed, falling back to JPEG', err);
        outType = 'image/jpeg';
        blob = await new Promise<Blob | null>(resolve =>
          canvas.toBlob(resolve, outType, settings.imageCompressionQuality));
      }
      console.log('[Spark Memo] compress', {
        originalType: file.type,
        originalSize: file.size,
        originalDims: `${bitmap.width}x${bitmap.height}`,
        targetDims: `${width}x${height}`,
        outType,
        outSize: blob?.size,
      });
      if (!blob || blob.size >= file.size) return uncompressed;
      return { blob, compressed: true, originalSize: file.size, compressedSize: blob.size };
    } catch (err) {
      console.error('[Spark Memo] image compression failed, using original', err);
      return uncompressed;
    }
  }

  /**
   * Checks a freshly-added image batch for EXIF capture time and/or GPS
   * location, and — if either is found — asks the user once whether to use
   * it. Only asks once per pending-image batch (guarded by the two
   * `pending*` fields already being set); a "yes" applies whichever of the
   * two pieces of information was actually found:
   *   - time: anchors this entry to the *earliest* capture time across the
   *     batch (including its calendar date), but only when it differs from
   *     "now" by more than 5 minutes — otherwise there's nothing to ask
   *     about time.
   *   - location: taken from the first JPEG in the batch that carries GPS,
   *     reverse-geocoded to a place name on a best-effort basis (a network
   *     failure just means the pill/tag falls back to raw coordinates).
   */
  private async maybeCheckImageMetadata(files: File[]): Promise<void> {
    if (!this.plugin.settings.imageTimeCheck) return;
    if (this.pendingCaptureOverride || this.pendingLocation) return;

    const capturedTimes = (await Promise.all(files.map(f => getImageCaptureTime(f))))
      .filter((d): d is Date => d !== null);
    const earliest = capturedTimes.length > 0 ? capturedTimes.reduce((a, b) => (a < b ? a : b)) : null;
    const diffMinutes = earliest ? Math.abs(Date.now() - earliest.getTime()) / 60000 : 0;
    const timeFound = earliest !== null && diffMinutes > 5;

    let gpsCoord: { latitude: number; longitude: number } | null = null;
    for (const file of files) {
      if (file.type !== 'image/jpeg' && file.type !== 'image/jpg') continue;
      try {
        gpsCoord = readExifGpsLocation(await file.arrayBuffer());
      } catch {
        gpsCoord = null;
      }
      if (gpsCoord) break;
    }

    if (!timeFound && !gpsCoord) return;

    await this.confirmAndApplyMetadata(timeFound ? earliest : null, diffMinutes, gpsCoord);
  }

  /**
   * Shows the "use this photo's time/location?" modal for already-detected
   * metadata and, if accepted, applies whichever of the two was actually
   * offered. Split out from `maybeCheckImageMetadata` so the hint pill can
   * re-open the same modal without re-reading the photo files.
   *
   * The modal is opened immediately with the raw coordinate (reverse
   * geocoding is a real network round-trip to Nominatim, and used to be
   * awaited *before* the modal appeared — with several photos this delayed
   * the popup by 1-2s, long enough that the user had already clicked
   * elsewhere and landed an accidental click on it instead). The place name
   * is filled in afterwards, the same way "重试" already does.
   */
  private async confirmAndApplyMetadata(
    capturedAt: Date | null,
    diffMinutes: number,
    gpsCoord: { latitude: number; longitude: number } | null,
  ): Promise<void> {
    let modalRef: ImageMetadataConfirmModal | null = null;
    const resultPromise = new Promise<ImageMetadataConfirmResult>(resolve => {
      modalRef = new ImageMetadataConfirmModal(
        this.app,
        {
          capturedAt,
          diffMinutes,
          location: gpsCoord ? { name: null, latitude: gpsCoord.latitude, longitude: gpsCoord.longitude } : null,
        },
        resolve,
        gpsCoord !== null,
      );
      modalRef.open();
    });

    // Kept alongside the modal's own copy so that if the user accepts before
    // this resolves, we can still apply the name once it lands — the modal
    // resolves with whatever it had *at click time* and won't update after.
    const geocodePromise = gpsCoord ? reverseGeocodeCity(gpsCoord.latitude, gpsCoord.longitude) : null;
    if (geocodePromise) void geocodePromise.then(name => modalRef?.setLocationName(name));

    const result = await resultPromise;

    if (!result.useImageInfo) {
      // Declined (or dismissed) — keep the offer around as a hint pill so
      // the user can re-open this same modal later without re-attaching the
      // photo. Applies while editing too: an uploaded photo's time/location
      // should be just as re-offerable there as when composing a new entry.
      this.pendingMetadataHint = { capturedAt, diffMinutes, gpsCoord };
      this.renderMetadataHintPill();
      return;
    }

    this.pendingMetadataHint = null;
    this.renderMetadataHintPill();
    this.lastAppliedMetadata = { capturedAt, diffMinutes, gpsCoord };

    const appliedParts: string[] = [];
    if (capturedAt) {
      const capturedDate = moment(capturedAt);
      this.pendingCaptureOverride = { date: capturedDate, time: formatTimeHHMM(capturedAt) };
      this.renderCaptureTimePill();
      appliedParts.push(
        capturedDate.isSame(moment(), 'day')
          ? t('capture.metadataAppliedTime', { time: this.pendingCaptureOverride.time })
          : t('capture.metadataAppliedTimeOtherDay', { date: capturedDate.format('YYYY-MM-DD') }),
      );
    }
    if (gpsCoord) {
      // Use `result.location.name`, not any locally-resolved name — the user
      // may have hit "重试" in the modal and gotten a name after all.
      const finalName = result.location?.name ?? null;
      this.pendingLocation = { latitude: gpsCoord.latitude, longitude: gpsCoord.longitude, name: finalName };
      this.renderLocationPill();
      appliedParts.push(t('capture.metadataAppliedLocation', { name: finalName ?? t('capture.coordOnly') }));

      // The user may have clicked "使用图片信息" while the geocode lookup was
      // still in flight — the modal resolved with `name: null` at that
      // instant and won't tell us anything more. Piggyback on the same
      // in-flight request so the pill still fills in the place name once it
      // lands, instead of being stuck showing raw coordinates forever.
      if (finalName === null && geocodePromise) {
        void geocodePromise.then(name => {
          if (
            this.pendingLocation &&
            this.pendingLocation.latitude === gpsCoord.latitude &&
            this.pendingLocation.longitude === gpsCoord.longitude &&
            this.pendingLocation.name === null
          ) {
            this.pendingLocation.name = name;
            this.renderLocationPill();
          }
        });
      }
    }
    notice(t('notice.metadataApplied', { parts: appliedParts.join(t('capture.metadataJoiner')) }));
  }

  private async saveAudioToVault(blob: Blob): Promise<TFile> {
    const ext = blob.type === 'audio/mp4' ? 'm4a' : 'webm';
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const baseName = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
    const filePath = await this.resolveAttachmentPath(this.plugin.settings.recordingFolder, baseName);
    const buffer = await blob.arrayBuffer();
    return this.app.vault.createBinary(filePath, buffer);
  }

  /** Adds a saved recording to the pending-attachments strip (not the text body). */
  private addPendingAudio(file: TFile, duration: string) {
    this.pendingAudio.push({ file, duration });
    this.renderAttachmentList();
    this.refreshSubmitState();
  }

  /**
   * Reads an existing audio file's actual duration (formatted `mm:ss`) for
   * re-populating the attachment strip on "编辑" — unlike a fresh recording,
   * we don't have an elapsed-time timer to read the duration from.
   * Resolves `'--:--'` if the file can't be probed (e.g. unsupported codec).
   */
  private async readAudioDuration(file: TFile): Promise<string> {
    return new Promise(resolve => {
      const audio = new Audio(this.app.vault.getResourcePath(file));
      const finish = (seconds: number | null) => {
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
        if (seconds === null || !isFinite(seconds)) {
          resolve('--:--');
          return;
        }
        const total = Math.floor(seconds);
        const m = String(Math.floor(total / 60)).padStart(2, '0');
        const s = String(total % 60).padStart(2, '0');
        resolve(`${m}:${s}`);
      };
      const onLoaded = () => finish(audio.duration);
      const onError = () => finish(null);
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.addEventListener('error', onError);
    });
  }

  /**
   * Transcribe an audio blob via an OpenAI-compatible /audio/transcriptions
   * endpoint. Builds the multipart/form-data body by hand because Obsidian's
   * `requestUrl` has no multipart helper. Returns the plain-text transcript.
   */
  private async transcribeAudio(blob: Blob, prompt = ''): Promise<string> {
    const s = this.plugin.settings;
    const endpoint = s.sttEndpoint.trim();
    const apiKey = s.sttApiKey.trim();
    if (endpoint.length === 0 || apiKey.length === 0) return '';

    const boundary = '----JPBoundary' + Math.floor(Math.random() * 1e9).toString(16);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];

    const field = (name: string, value: string) => {
      parts.push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    };
    field('model', s.sttModel.trim() || 'whisper-1');
    field('response_format', 'json');
    const lang = s.sttLanguage.trim();
    if (lang.length > 0) field('language', lang);
    // Prior-segment context — improves cross-boundary word accuracy. Whisper
    // and SenseVoice both honour the `prompt` field as a style/context hint.
    const promptText = prompt.trim();
    if (promptText.length > 0) field('prompt', promptText);

    const fileBytes = new Uint8Array(await blob.arrayBuffer());
    // Derive filename from the blob's mime so the endpoint sees a sensible ext.
    const ext = blob.type.includes('mp4') ? 'm4a'
      : blob.type.includes('wav') ? 'wav' : 'webm';
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${blob.type || 'audio/webm'}\r\n\r\n`,
      ),
    );
    parts.push(fileBytes);
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      body.set(p, offset);
      offset += p.length;
    }

    const resp = await requestUrl({
      url: endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body.buffer as ArrayBuffer,
    });
    const text = resp.json?.text;
    return typeof text === 'string' ? text : '';
  }

  private buildTimeline(root: HTMLElement) {
    this.timelineEl = root.createDiv({ cls: 'jp-timeline' });
    this.sentinelEl = root.createDiv({ cls: 'jp-timeline-sentinel' });
  }

  /** Build the prev/calendar/next controls, inline with the day header title. */
  private buildDayNavControls(parent: HTMLElement) {
    this.dayNavEl = parent.createDiv({ cls: 'jp-day-nav' });

    this.prevDayBtn = this.dayNavEl.createEl('button', {
      cls: 'jp-day-nav-btn',
      attr: { 'aria-label': t('capture.prevDay') },
    });
    setIcon(this.prevDayBtn, 'chevron-left');
    this.prevDayBtn.addEventListener('click', () => this.navigateDay(-1));

    this.calendarBtn = this.dayNavEl.createEl('button', {
      cls: 'jp-day-nav-btn jp-day-nav-calendar-btn',
      attr: { 'aria-label': t('capture.pickDate') },
    });
    setIcon(this.calendarBtn, 'calendar');
    this.calendarBtn.addEventListener('click', () => this.openCalendarPicker());

    this.nextDayBtn = this.dayNavEl.createEl('button', {
      cls: 'jp-day-nav-btn',
      attr: { 'aria-label': t('capture.nextDay') },
    });
    setIcon(this.nextDayBtn, 'chevron-right');
    this.nextDayBtn.addEventListener('click', () => this.navigateDay(1));
  }

  /** Move the capture timeline to the previous/next day (delta = ±1). No-op past today or the lookback floor. */
  private navigateDay(delta: number) {
    const today = moment().startOf('day');
    const next = this.currentDate.clone().add(delta, 'day');
    if (delta > 0 && next.isAfter(today, 'day')) return;
    if (delta < 0 && today.diff(next, 'days') > this.maxLookbackDays) return;
    this.currentDate = next;
    void this.fullRebuild();
  }

  /** Enable/disable the prev/next buttons at the today / lookback boundaries, and mark the calendar button when on today. */
  private updateDayNavState() {
    if (!this.prevDayBtn) return; // no day header rendered yet (e.g. daily-notes plugin disabled)
    const today = moment().startOf('day');
    const isToday = this.currentDate.isSame(today, 'day');
    const atLookbackFloor = today.diff(this.currentDate, 'days') >= this.maxLookbackDays;

    this.nextDayBtn.disabled = isToday;
    this.nextDayBtn.toggleClass('is-disabled', isToday);
    this.prevDayBtn.disabled = atLookbackFloor;
    this.prevDayBtn.toggleClass('is-disabled', atLookbackFloor);
    this.calendarBtn.toggleClass('is-today', isToday);
  }

  /** Open the date-picker modal; jumps the capture timeline to the chosen day. */
  private openCalendarPicker() {
    new CalendarPickerModal(
      this.app,
      this.currentDate,
      monthStart => this.getMonthEntryDays(monthStart),
      date => {
        this.currentDate = date.clone().startOf('day');
        void this.fullRebuild();
      },
    ).open();
  }

  /** Which days in `monthStart`'s month have a non-empty journal section — used to mark the calendar grid. */
  private async getMonthEntryDays(monthStart: moment.Moment): Promise<Set<string>> {
    const result = new Set<string>();
    if (!appHasDailyNotesPluginLoaded()) return result;

    const daysInMonth = monthStart.daysInMonth();
    const allNotes = getAllDailyNotes() as Record<string, TFile>;
    for (let d = 1; d <= daysInMonth; d++) {
      const date = monthStart.clone().date(d);
      try {
        const file = getDailyNote(date, allNotes) as TFile | null;
        if (!file) continue;
        const content = await this.app.vault.cachedRead(file);
        const section = findSection(
          content,
          this.plugin.settings.targetHeading,
          this.plugin.settings.headingLevel,
        );
        if (section && content.slice(section.from, section.to).trim().length > 0) {
          result.add(date.format('YYYY-MM-DD'));
        }
      } catch (err) {
        console.error('[Spark Memo] calendar day probe failed', err);
      }
    }
    return result;
  }

  // ── Behaviour ───────────────────────────────────────────────────────────

  private refreshSubmitState() {
    const hasContent = this.textareaEl.value.trim().length > 0
      || this.pendingImages.length > 0
      || this.pendingAudio.length > 0;
    this.submitBtn.toggleClass('jp-capture-submit--disabled', !hasContent);
    this.submitBtn.disabled = !hasContent;
  }

  private autoResizeTextarea() {
    this.textareaEl.style.height = 'auto';
    const next = Math.min(this.textareaEl.scrollHeight, 240);
    this.textareaEl.style.height = `${next}px`;
  }

  // ── Tag ("#") suggestion popup ──────────────────────────────────────────

  /**
   * Every tag used anywhere in the vault (frontmatter + inline), most-used first.
   * `mtime` = max file-modification time across all files carrying the tag, used as
   * a "last touched" fallback when the tag browser's precise per-entry index isn't
   * built yet or the tag only appears in frontmatter / non-daily notes.
   * Cached until metadata changes.
   */
  private getVaultTags(): { tag: string; count: number; mtime: number }[] {
    if (this.tagCache) return this.tagCache;
    const counts = new Map<string, number>();
    const mtimes = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      const tags = getAllTags(cache);
      if (!tags) continue;
      const mtime = file.stat.mtime;
      for (const tag of tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
        const prev = mtimes.get(tag) ?? 0;
        if (mtime > prev) mtimes.set(tag, mtime);
      }
    }
    const list = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count, mtime: mtimes.get(tag) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    this.tagCache = list;
    return list;
  }

  /** Looks at the caret position and shows/hides/refreshes the tag popup accordingly. */
  private updateTagSuggestions() {
    const value = this.textareaEl.value;
    const caret = this.textareaEl.selectionStart;
    if (caret !== this.textareaEl.selectionEnd) {
      this.closeTagSuggest();
      return;
    }
    // Walk back from the caret to the nearest "#" that starts the current
    // word — bail if we hit whitespace/newline first (not currently in a tag).
    let start = caret;
    // Accept both half-width '#' and full-width '＃' (U+FF03) — iOS/iPadOS
    // Chinese keyboards insert the full-width form when in Chinese mode.
    while (start > 0 && !/\s/.test(value[start - 1]) && value[start - 1] !== '#' && value[start - 1] !== '＃') start--;
    if (start === 0 || (value[start - 1] !== '#' && value[start - 1] !== '＃')) {
      this.closeTagSuggest();
      return;
    }
    start--; // include the '#' / '＃'
    const query = value.slice(start + 1, caret);
    // Obsidian tag syntax: any-script letters/numbers plus -/_// (nested
    // tags), no spaces or punctuation — and never purely numeric (Obsidian
    // doesn't recognize e.g. "#2026" as a tag at all).
    if (/[^\p{L}\p{N}_\-/]/u.test(query) || /^\p{N}+$/u.test(query)) {
      this.closeTagSuggest();
      return;
    }

    const all = this.getVaultTags();
    const q = query.toLowerCase();
    let matches: string[];
    if (q.length === 0) {
      // Sort by "last touched" — the max of (a) the memo entry's stated
      // timestamp if the tag browser has been opened and built its index, and
      // (b) the file's mtime. The max handles backfilled entries: if the
      // entry says "09:00 yesterday" but you actually typed it today, mtime
      // wins and the tag still surfaces as recent. Tags with no signal
      // (mtime = 0) fall back to count-based order via the tiebreakers.
      const agg = this.tagAggIndex;
      matches = all
        .map(t => {
          const entryTs = agg?.get(t.tag)?.lastTs ?? 0;
          const lastTs = Math.max(entryTs, t.mtime);
          return { tag: t.tag, count: t.count, lastTs };
        })
        .sort((a, b) => b.lastTs - a.lastTs || b.count - a.count || a.tag.localeCompare(b.tag))
        .slice(0, 8)
        .map(t => t.tag);
    } else {
      // Rank so that, for nested tags, matching the leaf segment (e.g. typing
      // "child" for "#parent/child") or the tag's own prefix outranks a
      // plain substring match buried in an unrelated parent segment.
      matches = all
        .map(t => {
          const body = t.tag.slice(1).toLowerCase();
          const segments = body.split('/');
          let score: number;
          if (body === q) score = 0;
          else if (body.startsWith(q)) score = 1;
          else if (segments.some(seg => seg.startsWith(q))) score = 2;
          else if (body.includes(q)) score = 3;
          else score = -1;
          return { tag: t.tag, count: t.count, score };
        })
        .filter(t => t.score >= 0)
        .sort((a, b) => a.score - b.score || b.count - a.count)
        .slice(0, 8)
        .map(t => t.tag);
    }

    if (matches.length === 0) {
      this.closeTagSuggest();
      return;
    }

    this.tagSuggestRange = { start, end: caret };
    this.tagSuggestMatches = matches;
    this.tagSuggestIndex = 0;
    this.renderTagSuggestList();
    this.positionTagSuggest(start);
  }

  private renderTagSuggestList() {
    this.tagSuggestEl.empty();
    this.tagSuggestMatches.forEach((tag, i) => {
      const item = this.tagSuggestEl.createDiv({
        cls: 'jp-tag-suggest-item' + (i === this.tagSuggestIndex ? ' jp-tag-suggest-item--active' : ''),
      });
      // Dim the parent segment(s) so the matched/leaf segment stands out for nested tags.
      const segments = tag.slice(1).split('/');
      item.createSpan({ text: '#' });
      if (segments.length > 1) {
        item.createSpan({ cls: 'jp-tag-suggest-item-parent', text: `${segments.slice(0, -1).join('/')}/` });
      }
      item.createSpan({ cls: 'jp-tag-suggest-item-leaf', text: segments[segments.length - 1] });
      // mousedown (not click) fires before the textarea's blur handler runs.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectTagSuggestion(tag);
      });
    });
    this.tagSuggestEl.toggleClass('jp-tag-suggest--hidden', false);
  }

  /** Positions the popup just below the line containing `charIndex`, using a hidden mirror div to measure caret pixel position. */
  private positionTagSuggest(charIndex: number) {
    const ta = this.textareaEl;
    const mirror = document.createElement('div');
    const style = window.getComputedStyle(ta);
    const props: string[] = [
      'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
    ];
    for (const prop of props) {
      (mirror.style as any)[prop] = (style as any)[prop];
    }
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    mirror.textContent = ta.value.slice(0, charIndex);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const markerTop = marker.offsetTop;
    const lineHeight = parseFloat(style.lineHeight) || marker.offsetHeight;
    document.body.removeChild(mirror);

    // inputWrapper (tagSuggestEl's offsetParent) shares its top-left with the
    // textarea, so the mirror's local offsets translate directly, minus the
    // scroll position.
    this.tagSuggestEl.style.left = `${ta.offsetLeft}px`;
    this.tagSuggestEl.style.top = `${ta.offsetTop + markerTop + lineHeight - ta.scrollTop}px`;
  }

  private closeTagSuggest() {
    if (!this.tagSuggestRange) return;
    this.tagSuggestRange = null;
    this.tagSuggestMatches = [];
    this.tagSuggestEl.toggleClass('jp-tag-suggest--hidden', true);
    this.tagSuggestEl.empty();
  }

  private selectTagSuggestion(tag: string) {
    const range = this.tagSuggestRange;
    if (!range) return;
    const value = this.textareaEl.value;
    const inserted = `${tag} `;
    this.textareaEl.value = value.slice(0, range.start) + inserted + value.slice(range.end);
    const newPos = range.start + inserted.length;
    this.closeTagSuggest();
    this.textareaEl.focus();
    this.textareaEl.setSelectionRange(newPos, newPos);
    this.refreshSubmitState();
    this.autoResizeTextarea();
  }

  private handleTagSuggestKeydown(e: KeyboardEvent) {
    if (!this.tagSuggestRange || this.tagSuggestMatches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.tagSuggestIndex = (this.tagSuggestIndex + 1) % this.tagSuggestMatches.length;
      this.renderTagSuggestList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.tagSuggestIndex = (this.tagSuggestIndex - 1 + this.tagSuggestMatches.length) % this.tagSuggestMatches.length;
      this.renderTagSuggestList();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.selectTagSuggestion(this.tagSuggestMatches[this.tagSuggestIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.closeTagSuggest();
    }
  }

  // ── Note mention ("@") suggestion popup ─────────────────────────────────

  /** Every markdown file in the vault, most recently modified first — recent notes are what you're usually reaching for. Cached until vault/metadata changes. */
  private getVaultFiles(): TFile[] {
    if (this.mentionCache) return this.mentionCache;
    const list = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
    this.mentionCache = list;
    return list;
  }

  /** Looks at the caret position and shows/hides/refreshes the mention popup accordingly. */
  private updateMentionSuggestions() {
    const value = this.textareaEl.value;
    const caret = this.textareaEl.selectionStart;
    if (caret !== this.textareaEl.selectionEnd) {
      this.closeMentionSuggest();
      return;
    }
    // Walk back from the caret to the nearest "@" on the current line — file
    // names may contain spaces, so (unlike tags) we don't stop at whitespace,
    // only at a newline or once we've scanned an unreasonably long span.
    let start = caret;
    // Accept both half-width '@' and full-width '＠' (U+FF20) — iOS/iPadOS
    // Chinese keyboards insert the full-width form when in Chinese mode.
    while (start > 0 && caret - start < 100 && value[start - 1] !== '@' && value[start - 1] !== '＠' && value[start - 1] !== '\n') start--;
    if (start === 0 || (value[start - 1] !== '@' && value[start - 1] !== '＠')) {
      this.closeMentionSuggest();
      return;
    }
    // Require the "@" to be at the start of a word (preceded by whitespace or
    // the start of the text) so we don't trigger inside things like emails.
    if (start > 1 && !/\s/.test(value[start - 2])) {
      this.closeMentionSuggest();
      return;
    }
    start--; // include the '@'
    const query = value.slice(start + 1, caret);
    if (query.includes('\n')) {
      this.closeMentionSuggest();
      return;
    }

    const all = this.getVaultFiles();
    const q = query.toLowerCase();
    // Notes currently open in a tab are almost always what the user is
    // reaching for — surface them first. Computed fresh each keystroke since
    // tab state changes independently of vault mtime.
    const openPaths = new Set<string>();
    this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
      const file = (leaf.view as any)?.file as TFile | undefined;
      if (file) openPaths.add(file.path);
    });
    const byOpenThenRecency = (a: TFile, b: TFile) => {
      const ao = openPaths.has(a.path) ? 1 : 0;
      const bo = openPaths.has(b.path) ? 1 : 0;
      if (ao !== bo) return bo - ao;
      return b.stat.mtime - a.stat.mtime;
    };
    // With no query, lean on the recency ordering from getVaultFiles() as-is,
    // but lift open tabs to the top. Once the user starts typing, prefer
    // name-prefix matches over mid-name matches (both groups keep their
    // open-tabs-first + recency order), since a prefix match is almost
    // always the note they mean.
    let matches: TFile[];
    if (q.length === 0) {
      matches = all.slice().sort(byOpenThenRecency);
    } else {
      const startsWith: TFile[] = [];
      const contains: TFile[] = [];
      for (const f of all) {
        const name = f.basename.toLowerCase();
        if (name.startsWith(q)) startsWith.push(f);
        else if (name.includes(q)) contains.push(f);
      }
      startsWith.sort(byOpenThenRecency);
      contains.sort(byOpenThenRecency);
      matches = startsWith.concat(contains);
    }
    matches = matches.slice(0, 8);

    if (matches.length === 0) {
      this.closeMentionSuggest();
      return;
    }

    this.mentionSuggestRange = { start, end: caret };
    this.mentionSuggestMatches = matches;
    this.mentionSuggestIndex = 0;
    this.renderMentionSuggestList();
    this.positionMentionSuggest(start);
  }

  private renderMentionSuggestList() {
    this.mentionSuggestEl.empty();
    this.mentionSuggestMatches.forEach((file, i) => {
      const item = this.mentionSuggestEl.createDiv({
        cls: 'jp-tag-suggest-item' + (i === this.mentionSuggestIndex ? ' jp-tag-suggest-item--active' : ''),
        text: file.basename,
      });
      // mousedown (not click) fires before the textarea's blur handler runs.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectMentionSuggestion(file);
      });
    });
    this.mentionSuggestEl.toggleClass('jp-tag-suggest--hidden', false);
  }

  /** Positions the popup just below the line containing `charIndex` — reuses the tag popup's mirror-div measurement approach. */
  private positionMentionSuggest(charIndex: number) {
    const ta = this.textareaEl;
    const mirror = document.createElement('div');
    const style = window.getComputedStyle(ta);
    const props: string[] = [
      'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
    ];
    for (const prop of props) {
      (mirror.style as any)[prop] = (style as any)[prop];
    }
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    mirror.textContent = ta.value.slice(0, charIndex);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const markerTop = marker.offsetTop;
    const lineHeight = parseFloat(style.lineHeight) || marker.offsetHeight;
    document.body.removeChild(mirror);

    this.mentionSuggestEl.style.left = `${ta.offsetLeft}px`;
    this.mentionSuggestEl.style.top = `${ta.offsetTop + markerTop + lineHeight - ta.scrollTop}px`;
  }

  private closeMentionSuggest() {
    if (!this.mentionSuggestRange) return;
    this.mentionSuggestRange = null;
    this.mentionSuggestMatches = [];
    this.mentionSuggestEl.toggleClass('jp-tag-suggest--hidden', true);
    this.mentionSuggestEl.empty();
  }

  /** Inserts an Obsidian-recognized `[[wikilink]]` (shortest unique linktext) for the chosen file. */
  private selectMentionSuggestion(file: TFile) {
    const range = this.mentionSuggestRange;
    if (!range) return;
    const linktext = this.app.metadataCache.fileToLinktext(file, '', true);
    const value = this.textareaEl.value;
    const inserted = `[[${linktext}]] `;
    this.textareaEl.value = value.slice(0, range.start) + inserted + value.slice(range.end);
    const newPos = range.start + inserted.length;
    this.closeMentionSuggest();
    this.textareaEl.focus();
    this.textareaEl.setSelectionRange(newPos, newPos);
    this.refreshSubmitState();
    this.autoResizeTextarea();
  }

  private handleMentionSuggestKeydown(e: KeyboardEvent) {
    if (!this.mentionSuggestRange || this.mentionSuggestMatches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.mentionSuggestIndex = (this.mentionSuggestIndex + 1) % this.mentionSuggestMatches.length;
      this.renderMentionSuggestList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.mentionSuggestIndex = (this.mentionSuggestIndex - 1 + this.mentionSuggestMatches.length) % this.mentionSuggestMatches.length;
      this.renderMentionSuggestList();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.selectMentionSuggestion(this.mentionSuggestMatches[this.mentionSuggestIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.closeMentionSuggest();
    }
  }

  private scheduleFullRebuild() {
    // Only skip when actively on the search tab — other tabs don't hold timeline state
    if (this.currentTab === 'search') return;
    if (this.rerenderTimer !== null) return;
    this.rerenderTimer = window.setTimeout(() => {
      this.rerenderTimer = null;
      void this.fullRebuild();
    }, 80);
  }

  private scheduleDayRefresh(day: DaySection) {
    // Light debounce per modify burst — Obsidian fires modify multiple times
    // for a single edit. 80ms is enough to coalesce.
    window.setTimeout(() => {
      void this.refreshDay(day);
    }, 80);
  }

  // ── Full rebuild ────────────────────────────────────────────────────────

  private async fullRebuild(): Promise<void> {
    this.disposeDays();
    this.timelineEl.empty();

    // No-plugin guard
    if (!appHasDailyNotesPluginLoaded()) {
      this.renderTopLevelMessage(t('notice.dailyNotesRequired'));
      this.exhausted = true;
      this.updateDayNavState();
      return;
    }

    // Single-day mode: no backward infinite-scroll in the capture pane.
    this.exhausted = true;
    this.loadingMore = false;

    const day = await this.buildDaySection(this.currentDate, /* allowEmpty */ true);
    if (day) {
      this.timelineEl.appendChild(day.el);
      this.days.push(day);
    }

    this.renderBottomDayNav();
    this.updateDayNavState();

    // Land on the top of the day (its date header) rather than wherever the
    // previous day happened to leave the scroll position.
    const scroller = this.containerEl.children[1] as HTMLElement | undefined;
    if (scroller) scroller.scrollTop = 0;
  }

  /**
   * Bottom-of-timeline nudge to the previous day — stands in for the old
   * infinite-scroll-loads-older-days behaviour, now that only one day is
   * shown at a time.
   */
  private renderBottomDayNav() {
    const today = moment().startOf('day');
    const atLookbackFloor = today.diff(this.currentDate, 'days') >= this.maxLookbackDays;
    const isToday = this.currentDate.isSame(today, 'day');

    const row = this.timelineEl.createDiv({ cls: 'jp-timeline-bottom-nav-row' });

    if (!atLookbackFloor) {
      const prevEl = row.createDiv({ cls: 'jp-timeline-bottom-nav' });
      const icon = prevEl.createSpan({ cls: 'jp-timeline-bottom-nav-icon' });
      setIcon(icon, 'chevron-down');
      prevEl.createSpan({ text: t('capture.viewPrevDay') });
      prevEl.addEventListener('click', () => this.navigateDay(-1));
    }

    if (!isToday) {
      const todayEl = row.createDiv({ cls: 'jp-timeline-bottom-nav jp-timeline-bottom-nav-today' });
      const icon = todayEl.createSpan({ cls: 'jp-timeline-bottom-nav-icon' });
      setIcon(icon, 'calendar-check');
      todayEl.createSpan({ text: t('capture.backToToday') });
      todayEl.addEventListener('click', () => {
        this.currentDate = moment().startOf('day');
        void this.fullRebuild();
      });
    }
  }

  /**
   * Probe `probeWindow` calendar days backwards looking for non-empty
   * journal sections, append any matches to the timeline. Updates
   * `nextProbeDate` and may flip `exhausted`.
   */
  private async loadMore(): Promise<void> {
    if (this.currentTab === 'location') return;
    if (this.searchActive) {
      await this.loadMoreSearchResults();
      return;
    }
    if (this.loadingMore || this.exhausted) return;
    this.loadingMore = true;

    try {
      let probed = 0;
      const today = moment().startOf('day');

      while (probed < this.probeWindow) {
        // Floor on lookback window
        if (today.diff(this.nextProbeDate, 'days') > this.maxLookbackDays) {
          this.exhausted = true;
          break;
        }

        const date = this.nextProbeDate.clone();
        this.nextProbeDate = this.nextProbeDate.clone().subtract(1, 'day');
        probed++;

        const day = await this.buildDaySection(date, /* allowEmpty */ false);
        if (day) {
          this.timelineEl.appendChild(day.el);
          this.days.push(day);
        }
      }

      if (this.exhausted) {
        this.markEndOfTimeline();
      }
    } finally {
      this.loadingMore = false;
    }
  }

  /**
   * Build a day section element + scope for the given date.
   * Returns null when the day has no content and `allowEmpty` is false.
   */
  private async buildDaySection(
    date: moment.Moment,
    allowEmpty: boolean,
  ): Promise<DaySection | null> {
    let file: TFile | null = null;
    try {
      file = getDailyNote(date, getAllDailyNotes()) as TFile | null;
    } catch (err) {
      console.error('[Spark Memo] daily note resolve failed', err);
    }

    let entries: JournalEntry[] = [];
    if (file) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const section = findSection(
          content,
          this.plugin.settings.targetHeading,
          this.plugin.settings.headingLevel,
        );
        if (section) {
          const text = content.slice(section.from, section.to);
          entries = parseJournalEntries(text, this.plugin.settings.timestampPattern);
        }
      } catch (err) {
        console.error('[Spark Memo] read failed', err);
      }
    }

    if (entries.length === 0 && !allowEmpty) {
      return null;
    }

    const day: DaySection = {
      date: date.clone(),
      el: createDiv({ cls: 'jp-timeline-day' }),
      scope: new Component(),
      filePath: file?.path ?? null,
    };
    day.scope.load();

    this.renderDayContent(day, entries);
    return day;
  }

  /** Refresh just one day's section in place (used on vault.modify). */
  private async refreshDay(day: DaySection): Promise<void> {
    let entries: JournalEntry[] = [];
    let file: TFile | null = null;
    try {
      file = getDailyNote(day.date, getAllDailyNotes()) as TFile | null;
      if (file) {
        const content = await this.app.vault.cachedRead(file);
        const section = findSection(
          content,
          this.plugin.settings.targetHeading,
          this.plugin.settings.headingLevel,
        );
        if (section) {
          const text = content.slice(section.from, section.to);
          entries = parseJournalEntries(text, this.plugin.settings.timestampPattern);
        }
      }
    } catch (err) {
      console.error('[Spark Memo] day refresh failed', err);
    }

    // Reset the day's lifecycle scope and DOM
    day.scope.unload();
    day.scope = new Component();
    day.scope.load();
    day.filePath = file?.path ?? day.filePath;
    day.el.empty();

    this.renderDayContent(day, entries);
  }

  /** Render the date header + entry rows for one day into `day.el`. */
  private renderDayContent(day: DaySection, entries: JournalEntry[]) {
    // Date header — first row of the day
    const headerLabel = this.formatDateHeader(day.date, entries.length);
    const headerRow = day.el.createDiv({
      cls: 'jp-timeline-entry jp-timeline-entry--header',
    });
    headerRow.createDiv({ cls: 'jp-timeline-dot jp-timeline-dot--header' });
    const headerCard = headerRow.createDiv({ cls: 'jp-timeline-header-card' });
    const headerText = headerCard.createDiv({ cls: 'jp-timeline-header-text' });
    headerText.createEl('div', { cls: 'jp-timeline-header-title', text: headerLabel.title });
    headerText.createEl('div', { cls: 'jp-timeline-header-sub', text: headerLabel.subtitle });
    this.buildDayNavControls(headerCard);
    this.updateDayNavState();

    if (entries.length === 0) {
      // The input box always writes to today, so the "写点什么吧" nudge only
      // makes sense when today's own section is the one being viewed.
      const isToday = day.date.isSame(moment().startOf('day'), 'day');
      day.el.createDiv({
        cls: 'jp-capture-empty',
        text: isToday ? t('capture.emptyDayNudge') : t('capture.emptyDayNoNudge'),
      });
      return;
    }

    // Sort entries within the day
    const latestTs = entries.reduce<string>(
      (acc, e) => (e.timestamp > acc ? e.timestamp : acc),
      '',
    );
    const sorted = [...entries].sort((a, b) => {
      if (a.timestamp === b.timestamp) {
        return b.lineIndex - a.lineIndex;
      }
      return a.timestamp < b.timestamp ? 1 : -1;
    });

    const sourcePath = day.filePath ?? '';
    for (const entry of sorted) {
      const row = day.el.createDiv({ cls: 'jp-timeline-entry' });

      const dot = row.createDiv({ cls: 'jp-timeline-dot' });
      // "Latest" highlight only applies on today's section (otherwise every
      // historical day would have its own filled dot, which is noisy).
      if (
        day.date.isSame(moment().startOf('day'), 'day') &&
        entry.timestamp === latestTs
      ) {
        dot.addClass('jp-timeline-dot--latest');
      }

      // Header: timestamp pill anchored to the dot via a short connector line.
      const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
      head.createEl('span', { cls: 'jp-timestamp', text: entry.timestamp });
      const { text: bodyText, location } = extractLocationTag(entry.text);
      if (location) this.renderLocationChip(head, day, entry, location);

      // Body bubble: chat-style rounded card holding the rendered markdown.
      const bubble = row.createDiv({ cls: 'jp-timeline-bubble' });
      void MarkdownRenderer.render(this.app, bodyText, bubble, sourcePath, day.scope)
        .then(() => {
          this.applyImageGrid(bubble);
          this.attachImagePreviews(bubble);
          this.attachTagClickHandlers(bubble);
        });

      // Context menu: copy / delete (with optional audio cleanup).
      // Attached to both the timestamp pill and bubble so right-click /
      // long-press anywhere on the row triggers it.
      const openMenu = (evt: MouseEvent) => {
        evt.preventDefault();
        this.openEntryMenu(evt, day, entry);
      };
      head.addEventListener('contextmenu', openMenu);
      bubble.addEventListener('contextmenu', openMenu);
    }
  }

  // ── Location aggregation (location tab) ─────────────────────────────────

  /**
   * Full scan of every daily note, grouping entries by their location tag's
   * city name. Cached in `locationIndex` until any md file changes (see the
   * vault 'modify'/'create'/'delete' listeners in onOpen, which null it out).
   */
  private async loadLocationIndex(): Promise<void> {
    if (this.locationIndex || this.locationLoading) return;
    this.locationLoading = true;
    this.renderTopLevelMessage(t('location.scanning'));

    try {
      if (!appHasDailyNotesPluginLoaded()) {
        this.renderTopLevelMessage(t('notice.dailyNotesRequired'));
        return;
      }

      const all = getAllDailyNotes() as Record<string, TFile>;
      const index = new Map<
        string,
        { count: number; lastTs: number; entries: Array<{ file: TFile; date: moment.Moment; entry: JournalEntry }> }
      >();

      for (const file of Object.values(all)) {
        if (!(file instanceof TFile)) continue;
        const date = getDateFromFile(file, 'day');
        if (!date) continue;
        const day = date.clone().startOf('day');

        let content: string;
        try {
          content = await this.app.vault.cachedRead(file);
        } catch {
          continue;
        }
        const section = findSection(content, this.plugin.settings.targetHeading, this.plugin.settings.headingLevel);
        if (!section) continue;
        const text = content.slice(section.from, section.to);
        const entries = parseJournalEntries(text, this.plugin.settings.timestampPattern);

        for (const entry of entries) {
          const { location } = extractLocationTag(entry.text);
          if (!location) continue;

          const [hh, mm] = entry.timestamp.split(':').map(Number);
          const ts = day
            .clone()
            .add(hh || 0, 'hours')
            .add(mm || 0, 'minutes')
            .valueOf();

          let data = index.get(location.name);
          if (!data) {
            data = { count: 0, lastTs: 0, entries: [] };
            index.set(location.name, data);
          }
          data.count++;
          if (ts > data.lastTs) data.lastTs = ts;
          data.entries.push({ file, date: day, entry });
        }
      }

      this.locationIndex = index;
    } catch (err) {
      console.error('[Spark Memo] location index build failed', err);
      this.renderTopLevelMessage(t('location.scanFailed'));
    } finally {
      this.locationLoading = false;
    }
  }

  /** Render the top-level "all locations" list, sorted by most-recently-visited first. */
  private renderLocationList() {
    this.disposeDays();
    this.timelineEl.empty();

    if (!this.locationIndex || this.locationIndex.size === 0) {
      this.locationTitleEl.setText('');
      this.renderTopLevelMessage(this.pickRandomLocationEmptyPlaceholder());
      return;
    }

    this.locationTitleEl.setText(t('location.allCount', { count: String(this.locationIndex.size) }));

    const cities = [...this.locationIndex.entries()].sort((a, b) => b[1].lastTs - a[1].lastTs);
    const listEl = this.timelineEl.createDiv({ cls: 'jp-location-list' });
    for (const [city, data] of cities) {
      const item = listEl.createDiv({ cls: 'jp-location-item' });
      const iconEl = item.createSpan({ cls: 'jp-location-item-icon' });
      setIcon(iconEl, 'map-pin');
      item.createDiv({ cls: 'jp-location-item-name', text: city });
      item.createDiv({ cls: 'jp-location-item-count', text: `${data.count}` });
      item.addEventListener('click', () => this.selectLocationCity(city));
    }

    this.exhausted = true;
  }

  /** Drill into a single city: render its memos as day-grouped timeline entries, newest first. */
  private selectLocationCity(city: string) {
    const data = this.locationIndex?.get(city);
    if (!data) return;

    this.selectedLocationCity = city;
    this.locationBackBtn.style.display = '';
    this.locationTitleEl.setText(city);

    this.disposeDays();
    this.timelineEl.empty();

    const byDate = new Map<string, { date: moment.Moment; file: TFile; entries: JournalEntry[] }>();
    for (const e of data.entries) {
      const key = e.date.format('YYYY-MM-DD');
      let bucket = byDate.get(key);
      if (!bucket) {
        bucket = { date: e.date, file: e.file, entries: [] };
        byDate.set(key, bucket);
      }
      bucket.entries.push(e.entry);
    }
    const sortedDays = [...byDate.values()].sort((a, b) => (a.date.isBefore(b.date) ? 1 : -1));

    if (sortedDays.length === 0) {
      this.renderTopLevelMessage(t('location.cityNotFound', { city }));
      return;
    }

    for (const d of sortedDays) {
      const day: DaySection = {
        date: d.date,
        el: createDiv({ cls: 'jp-timeline-day' }),
        scope: new Component(),
        filePath: d.file.path,
      };
      day.scope.load();
      this.renderLocationDayContent(day, d.entries);
      this.timelineEl.appendChild(day.el);
      this.days.push(day);
    }

    this.exhausted = true;
    this.markEndOfTimeline();
  }

  /** Return from a city's memo list back to the "all locations" list. */
  private backToLocationList() {
    this.selectedLocationCity = null;
    this.locationBackBtn.style.display = 'none';
    this.locationTitleEl.setText(t('location.all'));
    this.renderLocationList();
  }

  /** Render one day's entries for a selected city — same shape as search results, no keyword highlight. */
  private renderLocationDayContent(day: DaySection, entries: JournalEntry[]) {
    const headerLabel = this.formatDateHeader(day.date, entries.length);
    const headerRow = day.el.createDiv({ cls: 'jp-timeline-entry jp-timeline-entry--header' });
    headerRow.createDiv({ cls: 'jp-timeline-dot jp-timeline-dot--header' });
    const headerCard = headerRow.createDiv({ cls: 'jp-timeline-header-card' });
    const headerText = headerCard.createDiv({ cls: 'jp-timeline-header-text' });
    headerText.createEl('div', { cls: 'jp-timeline-header-title', text: headerLabel.title });
    headerText.createEl('div', { cls: 'jp-timeline-header-sub', text: t('capture.memoCount', { count: String(entries.length) }) });
    this.addOpenNoteBtn(headerCard, day);

    const sourcePath = day.filePath ?? '';
    const sorted = [...entries].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b.lineIndex - a.lineIndex,
    );

    for (const entry of sorted) {
      const row = day.el.createDiv({ cls: 'jp-timeline-entry' });
      row.createDiv({ cls: 'jp-timeline-dot' });

      const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
      const tsEl = head.createEl('span', {
        cls: 'jp-timestamp jp-location-jump',
        text: entry.timestamp,
        attr: { 'aria-label': t('capture.jumpToSource'), title: t('capture.jumpToSource') },
      });
      tsEl.addEventListener('click', () => void this.openEntryAtLine(sourcePath, entry));
      const { text: bodyText, location } = extractLocationTag(entry.text);
      if (location) this.renderLocationChip(head, day, entry, location);

      const bubble = row.createDiv({ cls: 'jp-timeline-bubble jp-search-bubble' });
      void MarkdownRenderer.render(this.app, bodyText, bubble, sourcePath, day.scope).then(() => {
        this.applyImageGrid(bubble);
        this.attachImagePreviews(bubble);
        this.attachTagClickHandlers(bubble);
      });

      const openMenu = (evt: MouseEvent) => {
        evt.preventDefault();
        this.openEntryMenu(evt, day, entry);
      };
      head.addEventListener('contextmenu', openMenu);
      bubble.addEventListener('contextmenu', openMenu);
    }
  }

  // ── Tag aggregation (tag tab) ────────────────────────────────────────────

  /**
   * Full scan of every daily note, grouping entries by the `#tag`s found in
   * their body text. Cached in `tagAggIndex` until any md file changes (see
   * the vault 'modify'/'create'/'delete' listeners in onOpen, which null it
   * out) — mirrors `loadLocationIndex` but keys on tag name instead of city.
   */
  /** Kicks off the scan on first call; concurrent/later callers await the same in-flight promise. */
  private loadTagIndex(): Promise<void> {
    if (this.tagAggIndex) return Promise.resolve();
    if (this.tagAggLoadPromise) return this.tagAggLoadPromise;
    this.tagAggLoadPromise = this.buildTagIndex().finally(() => {
      this.tagAggLoadPromise = null;
    });
    return this.tagAggLoadPromise;
  }

  private async buildTagIndex(): Promise<void> {
    this.tagAggLoading = true;
    this.renderTopLevelMessage(t('tag.scanning'));

    try {
      if (!appHasDailyNotesPluginLoaded()) {
        this.renderTopLevelMessage(t('notice.dailyNotesRequired'));
        return;
      }

      const all = getAllDailyNotes() as Record<string, TFile>;
      const index = new Map<
        string,
        { count: number; lastTs: number; entries: Array<{ file: TFile; date: moment.Moment; entry: JournalEntry }> }
      >();

      for (const file of Object.values(all)) {
        if (!(file instanceof TFile)) continue;
        const date = getDateFromFile(file, 'day');
        if (!date) continue;
        const day = date.clone().startOf('day');

        let content: string;
        try {
          content = await this.app.vault.cachedRead(file);
        } catch {
          continue;
        }
        const section = findSection(content, this.plugin.settings.targetHeading, this.plugin.settings.headingLevel);
        if (!section) continue;
        const text = content.slice(section.from, section.to);
        const entries = parseJournalEntries(text, this.plugin.settings.timestampPattern);

        for (const entry of entries) {
          const tags = extractEntryTags(entry.text);
          if (tags.length === 0) continue;

          const [hh, mm] = entry.timestamp.split(':').map(Number);
          const ts = day
            .clone()
            .add(hh || 0, 'hours')
            .add(mm || 0, 'minutes')
            .valueOf();

          for (const tag of tags) {
            let data = index.get(tag);
            if (!data) {
              data = { count: 0, lastTs: 0, entries: [] };
              index.set(tag, data);
            }
            data.count++;
            if (ts > data.lastTs) data.lastTs = ts;
            data.entries.push({ file, date: day, entry });
          }
        }
      }

      this.tagAggIndex = index;
    } catch (err) {
      console.error('[Spark Memo] tag index build failed', err);
      this.renderTopLevelMessage(t('tag.scanFailed'));
    } finally {
      this.tagAggLoading = false;
    }
  }

  /** Group the flat `tagAggIndex` into a `/`-nested tree, e.g. "#parent/child" hangs under "#parent". */
  private buildTagTree(): Map<string, TagTreeNode> {
    const roots = new Map<string, TagTreeNode>();
    if (!this.tagAggIndex) return roots;

    for (const [tag, data] of this.tagAggIndex) {
      const segments = tag.slice(1).split('/').filter(s => s.length > 0);
      if (segments.length === 0) continue;
      let siblings = roots;
      let path = '';
      let node: TagTreeNode | null = null;
      for (const segment of segments) {
        path += (path ? '/' : '#') + segment;
        let next = siblings.get(segment);
        if (!next) {
          next = { name: segment, fullPath: path, own: null, children: new Map(), totalCount: 0, lastTs: 0 };
          siblings.set(segment, next);
        }
        node = next;
        siblings = next.children;
      }
      if (node) node.own = data;
    }

    const computeTotals = (node: TagTreeNode): void => {
      let count = node.own?.count ?? 0;
      let lastTs = node.own?.lastTs ?? 0;
      for (const child of node.children.values()) {
        computeTotals(child);
        count += child.totalCount;
        lastTs = Math.max(lastTs, child.lastTs);
      }
      node.totalCount = count;
      node.lastTs = lastTs;
    };
    for (const root of roots.values()) computeTotals(root);

    return roots;
  }

  /** Render the top-level "all tags" list, sorted by most-recently-used first. */
  private renderTagList() {
    this.disposeDays();
    this.timelineEl.empty();

    if (!this.tagAggIndex || this.tagAggIndex.size === 0) {
      this.tagAggTitleEl.setText('');
      this.renderTopLevelMessage(t('tag.empty'));
      return;
    }

    this.tagAggTitleEl.setText(t('tag.allCount', { count: String(this.tagAggIndex.size) }));

    const tree = this.buildTagTree();
    const roots = [...tree.values()].sort((a, b) => b.lastTs - a.lastTs);
    const listEl = this.timelineEl.createDiv({ cls: 'jp-tag-list' });
    for (const node of roots) {
      this.renderTagNode(node, listEl, 0);
    }

    this.exhausted = true;
  }

  /** Render one tag-tree node (and, if expanded, its children) as a row. */
  private renderTagNode(node: TagTreeNode, container: HTMLElement, depth: number) {
    const hasChildren = node.children.size > 0;
    const isExpanded = this.expandedTagPaths.has(node.fullPath);

    const item = container.createDiv({
      cls: 'jp-location-item jp-tag-item' + (hasChildren ? ' jp-tag-item--parent' : ''),
    });
    item.style.marginLeft = `${depth * 18}px`;

    const chevronEl = item.createSpan({ cls: 'jp-tag-item-chevron' + (hasChildren ? '' : ' jp-tag-item-chevron--spacer') });
    if (hasChildren) {
      setIcon(chevronEl, isExpanded ? 'chevron-down' : 'chevron-right');
      chevronEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleTagExpand(node.fullPath);
      });
    }

    const iconEl = item.createSpan({ cls: 'jp-location-item-icon' });
    setIcon(iconEl, 'tag');
    item.createDiv({ cls: 'jp-location-item-name', text: depth === 0 ? `#${node.name}` : node.name });
    item.createDiv({ cls: 'jp-location-item-count', text: `${node.totalCount}` });

    item.addEventListener('click', () => {
      if (node.own) this.selectTag(node.fullPath);
      else if (hasChildren) this.toggleTagExpand(node.fullPath);
    });

    // Management (rename/move/merge/delete) lives on right-click rather than
    // an always-reserved row button — desktop-only, same as the timeline's
    // entry context menu (there's no touch equivalent for a hover affordance).
    if (!Platform.isMobile) {
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.openTagMenu(e, node);
      });
    }

    if (hasChildren && isExpanded) {
      const children = [...node.children.values()].sort((a, b) => b.lastTs - a.lastTs);
      for (const child of children) {
        this.renderTagNode(child, container, depth + 1);
      }
    }
  }

  private toggleTagExpand(path: string) {
    if (this.expandedTagPaths.has(path)) this.expandedTagPaths.delete(path);
    else this.expandedTagPaths.add(path);
    void this.ensureTagIndexAndRenderList();
  }

  /**
   * `tagAggIndex` can go stale between renders — the vault's own `modify`
   * listener nulls it out on any daily-note write, including ones this view
   * itself just made (rename/move/merge/delete). `loadTagIndex` is a no-op
   * when the index is already warm, so this is cheap on the common path.
   */
  private async ensureTagIndexAndRenderList(): Promise<void> {
    await this.loadTagIndex();
    if (this.currentTab === 'tag' && this.selectedTag === null) {
      this.renderTagList();
    }
  }

  /** Every tag-tree node's full path (own-tagged or pure category nodes alike), for move/merge target pickers. */
  private collectAllTagPaths(): string[] {
    const paths: string[] = [];
    const walk = (nodes: Map<string, TagTreeNode>) => {
      for (const node of nodes.values()) {
        paths.push(node.fullPath);
        walk(node.children);
      }
    };
    walk(this.buildTagTree());
    return paths.sort();
  }

  /** "重命名 / 移到子标签下 / 合并到另一个标签 / 删除" — the tag row's hover menu. */
  private openTagMenu(evt: MouseEvent, node: TagTreeNode) {
    const menu = new Menu();

    menu.addItem(item =>
      item
        .setTitle(t('tag.manage.rename'))
        .setIcon('pencil')
        .onClick(() => {
          new TagRenameModal(this.app, node.name, (newName) => {
            void this.handleRenameTag(node, newName);
          }).open();
        }),
    );

    menu.addItem(item =>
      item
        .setTitle(t('tag.manage.moveUnder'))
        .setIcon('corner-right-down')
        .onClick(() => {
          void this.openTagTargetPicker(node, 'move');
        }),
    );

    menu.addItem(item =>
      item
        .setTitle(t('tag.manage.mergeInto'))
        .setIcon('git-merge')
        .onClick(() => {
          void this.openTagTargetPicker(node, 'merge');
        }),
    );

    menu.addSeparator();

    menu.addItem(item =>
      item
        .setTitle(t('tag.manage.delete'))
        .setIcon('trash-2')
        .onClick(() => {
          new TagDeleteConfirmModal(this.app, {
            tag: node.fullPath,
            hasChildren: node.children.size > 0,
            ownCount: node.own?.count ?? 0,
            totalCount: node.totalCount,
            onConfirm: (includeChildren) => {
              void this.runTagRewrite(
                this.tagDeleteMapper(node.fullPath, includeChildren),
                includeChildren ? 'tag.manage.deleteDoneWithChildren' : 'tag.manage.deleteDone',
              );
            },
          }).open();
        }),
    );

    menu.showAtMouseEvent(evt);
  }

  /** Opens a fuzzy picker of candidate tags for "move under" / "merge into" — excludes the node itself and its own descendants (would create a cycle). */
  private async openTagTargetPicker(node: TagTreeNode, mode: 'move' | 'merge'): Promise<void> {
    // `tagAggIndex` may have gone stale since this row was rendered (see
    // `ensureTagIndexAndRenderList`) — reload before reading it here too,
    // otherwise the candidate list can silently come back empty.
    await this.loadTagIndex();
    const candidates = this.collectAllTagPaths().filter(
      p => p !== node.fullPath && !p.startsWith(`${node.fullPath}/`),
    );
    if (mode === 'merge' && candidates.length === 0) {
      notice(t('tag.manage.noOtherTags'));
      return;
    }
    const topLevelOption = mode === 'move' ? t('tag.manage.topLevelOption') : null;
    const items = topLevelOption ? [topLevelOption, ...candidates] : candidates;

    new TagPickerModal(this.app, items, mode, (choice) => {
      if (mode === 'move') {
        const newFull = choice === topLevelOption ? `#${node.name}` : `${choice}/${node.name}`;
        void this.handleRenameTagPath(node.fullPath, newFull, 'tag.manage.moveDone');
      } else {
        void this.handleRenameTagPath(node.fullPath, choice, 'tag.manage.mergeDone');
      }
    }).open();
  }

  /** Renames just this node's own segment, keeping its current parent (use "move" to change parent). */
  private async handleRenameTag(node: TagTreeNode, newName: string): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === node.name) return;
    if (/[\s#/]/.test(trimmed)) {
      notice(t('tag.manage.invalidName'));
      return;
    }
    const idx = node.fullPath.lastIndexOf('/');
    const parentPrefix = idx === -1 ? '' : node.fullPath.slice(0, idx);
    const newFull = parentPrefix ? `${parentPrefix}/${trimmed}` : `#${trimmed}`;
    await this.handleRenameTagPath(node.fullPath, newFull, 'tag.manage.renameDone');
  }

  /** Shared rewrite for rename / move / merge — all three are "replace this tag (and its subtree) with a new full path". */
  private async handleRenameTagPath(oldFull: string, newFull: string, successKey: string): Promise<void> {
    if (newFull === oldFull) return;
    await this.runTagRewrite(this.tagRenamePrefixMapper(oldFull, newFull), successKey);
  }

  private tagRenamePrefixMapper(oldFull: string, newFull: string): (tag: string) => string | null {
    return (tag: string) => {
      if (tag === oldFull) return newFull;
      if (tag.startsWith(`${oldFull}/`)) return newFull + tag.slice(oldFull.length);
      return tag;
    };
  }

  private tagDeleteMapper(oldFull: string, includeChildren: boolean): (tag: string) => string | null {
    return (tag: string) => {
      if (tag === oldFull) return null;
      if (includeChildren && tag.startsWith(`${oldFull}/`)) return null;
      return tag;
    };
  }

  /** Batch-rewrites tags across every daily note's Memo section, refreshes the tag index/cache, and reports the result. */
  private async runTagRewrite(mapTag: (tag: string) => string | null, successKey: string): Promise<void> {
    try {
      const { filesChanged, entriesChanged } = await this.applyTagRewrite(mapTag);
      if (entriesChanged === 0) {
        notice(t('tag.manage.noChanges'));
        return;
      }
      this.tagAggIndex = null;
      this.tagCache = null;
      await this.ensureTagIndexAndRenderList();
      notice(t(successKey, { count: String(entriesChanged), files: String(filesChanged) }));
    } catch (err) {
      console.error('[Spark Memo] tag rewrite failed', err);
      notice(t('tag.manage.failed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Reads every daily note, rewrites tag tokens in its Memo section via `mapTag`, and writes back only the files that actually changed. */
  private async applyTagRewrite(mapTag: (tag: string) => string | null): Promise<{ filesChanged: number; entriesChanged: number }> {
    const all = getAllDailyNotes() as Record<string, TFile>;
    let filesChanged = 0;
    let entriesChanged = 0;
    for (const file of Object.values(all)) {
      if (!(file instanceof TFile)) continue;
      let content: string;
      try {
        content = await this.app.vault.read(file);
      } catch {
        continue;
      }
      const { content: next, changedCount } = rewriteTagsInSection(content, this.plugin.settings, mapTag);
      if (changedCount === 0) continue;
      await this.app.vault.modify(file, next);
      filesChanged++;
      entriesChanged += changedCount;
    }
    return { filesChanged, entriesChanged };
  }

  /** Drill into a single tag: render its memos as day-grouped timeline entries, newest first. */
  private selectTag(tag: string) {
    const data = this.tagAggIndex?.get(tag);
    if (!data) return;

    this.selectedTag = tag;
    this.tagAggBackBtn.style.display = '';
    this.tagAggTitleEl.setText(tag);

    this.disposeDays();
    this.timelineEl.empty();

    const byDate = new Map<string, { date: moment.Moment; file: TFile; entries: JournalEntry[] }>();
    for (const e of data.entries) {
      const key = e.date.format('YYYY-MM-DD');
      let bucket = byDate.get(key);
      if (!bucket) {
        bucket = { date: e.date, file: e.file, entries: [] };
        byDate.set(key, bucket);
      }
      bucket.entries.push(e.entry);
    }
    const sortedDays = [...byDate.values()].sort((a, b) => (a.date.isBefore(b.date) ? 1 : -1));

    if (sortedDays.length === 0) {
      this.renderTopLevelMessage(t('tag.tagNotFound', { tag }));
      return;
    }

    for (const d of sortedDays) {
      const day: DaySection = {
        date: d.date,
        el: createDiv({ cls: 'jp-timeline-day' }),
        scope: new Component(),
        filePath: d.file.path,
      };
      day.scope.load();
      this.renderTagDayContent(day, d.entries);
      this.timelineEl.appendChild(day.el);
      this.days.push(day);
    }

    this.exhausted = true;
    this.markEndOfTimeline();
  }

  /** Return from a tag's memo list back to the "all tags" list. */
  private backToTagList() {
    this.selectedTag = null;
    this.tagAggBackBtn.style.display = 'none';
    this.tagAggTitleEl.setText(t('tag.all'));
    this.renderTagList();
  }

  /** Render one day's entries for a selected tag — same shape as the location tab's day renderer. */
  private renderTagDayContent(day: DaySection, entries: JournalEntry[]) {
    const headerLabel = this.formatDateHeader(day.date, entries.length);
    const headerRow = day.el.createDiv({ cls: 'jp-timeline-entry jp-timeline-entry--header' });
    headerRow.createDiv({ cls: 'jp-timeline-dot jp-timeline-dot--header' });
    const headerCard = headerRow.createDiv({ cls: 'jp-timeline-header-card' });
    const headerText = headerCard.createDiv({ cls: 'jp-timeline-header-text' });
    headerText.createEl('div', { cls: 'jp-timeline-header-title', text: headerLabel.title });
    headerText.createEl('div', { cls: 'jp-timeline-header-sub', text: t('capture.memoCount', { count: String(entries.length) }) });
    this.addOpenNoteBtn(headerCard, day);

    const sourcePath = day.filePath ?? '';
    const sorted = [...entries].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b.lineIndex - a.lineIndex,
    );

    for (const entry of sorted) {
      const row = day.el.createDiv({ cls: 'jp-timeline-entry' });
      row.createDiv({ cls: 'jp-timeline-dot' });

      const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
      const tsEl = head.createEl('span', {
        cls: 'jp-timestamp jp-location-jump',
        text: entry.timestamp,
        attr: { 'aria-label': t('capture.jumpToSource'), title: t('capture.jumpToSource') },
      });
      tsEl.addEventListener('click', () => void this.openEntryAtLine(sourcePath, entry));
      const { text: bodyText, location } = extractLocationTag(entry.text);
      if (location) this.renderLocationChip(head, day, entry, location);

      const bubble = row.createDiv({ cls: 'jp-timeline-bubble jp-search-bubble' });
      void MarkdownRenderer.render(this.app, bodyText, bubble, sourcePath, day.scope).then(() => {
        this.applyImageGrid(bubble);
        this.attachImagePreviews(bubble);
        this.attachTagClickHandlers(bubble);
      });

      const openMenu = (evt: MouseEvent) => {
        evt.preventDefault();
        this.openEntryMenu(evt, day, entry);
      };
      head.addEventListener('contextmenu', openMenu);
      bubble.addEventListener('contextmenu', openMenu);
    }
  }

  /** Open `filePath` and place the cursor on `entry`'s source line. */
  private async openEntryAtLine(filePath: string, entry: JournalEntry): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) {
        notice(t('notice.journalFileNotFound'));
        return;
      }
      const content = await this.app.vault.cachedRead(file);
      const section = findSection(content, this.plugin.settings.targetHeading, this.plugin.settings.headingLevel);
      if (!section) {
        notice(t('notice.journalSectionNotFound'));
        return;
      }
      const lineOffset = content.slice(0, section.from).split('\n').length - 1;
      const targetLine = lineOffset + entry.lineIndex;

      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        view.editor.setCursor({ line: targetLine, ch: 0 });
        view.editor.scrollIntoView({ from: { line: targetLine, ch: 0 }, to: { line: targetLine, ch: 0 } }, true);
      }
    } catch (err) {
      console.error('[Spark Memo] open entry failed', err);
      notice(t('notice.openFailed'));
    }
  }

  /** Build a human-readable date label. */
  private formatDateHeader(d: moment.Moment, count: number): { title: string; subtitle: string } {
    const weekdayNames = [
      t('capture.weekday.sun'), t('capture.weekday.mon'), t('capture.weekday.tue'),
      t('capture.weekday.wed'), t('capture.weekday.thu'), t('capture.weekday.fri'), t('capture.weekday.sat'),
    ];
    const weekdayLabel = weekdayNames[d.day()];
    const isCurrentYear = d.year() === moment().year();
    const dateLabel = d.format(isCurrentYear ? 'M/D' : 'YYYY/M/D') + ` · ${weekdayLabel}`;
    const today = moment().startOf('day');
    const diff = d.diff(today, 'days');
    let relative = '';
    if (diff === 0) relative = t('capture.relativeToday');
    else if (diff === -1) relative = t('capture.relativeYesterday');
    const title = dateLabel + relative;
    const subtitle = count === 0 ? t('capture.noMemoYet') : t('capture.memoCount', { count: String(count) });
    return { title, subtitle };
  }

  private renderTopLevelMessage(msg: string) {
    this.timelineEl.createDiv({ cls: 'jp-capture-empty', text: msg });
  }

  private markEndOfTimeline() {
    // Replace sentinel functionality with a static end marker
    const end = createDiv({ cls: 'jp-timeline-end', text: t('capture.loadedToEarliest') });
    this.sentinelEl.replaceWith(end);
    this.sentinelEl = end;
  }

  private setupIntersectionObserver() {
    if (this.intersectionObs) this.intersectionObs.disconnect();
    const root = this.containerEl.children[1] as HTMLElement;
    this.intersectionObs = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting && !this.exhausted && !this.loadingMore) {
            void this.loadMore();
          }
        }
      },
      { root, rootMargin: '200px 0px 200px 0px', threshold: 0 },
    );
    this.intersectionObs.observe(this.sentinelEl);
  }

  /** Tear down all loaded day sections (Component scopes + DOM). */
  private disposeDays() {
    for (const d of this.days) d.scope.unload();
    this.days = [];
  }

  // ── Random memo (search tab) ────────────────────────────────────────────

  /** Pick a random entry from a random past daily note and render it in the search timeline. */
  private async showRandomMemo(): Promise<void> {
    if (!appHasDailyNotesPluginLoaded()) {
      this.disposeDays();
      this.timelineEl.empty();
      this.renderTopLevelMessage(t('notice.dailyNotesRequired'));
      return;
    }

    const allNotes = getAllDailyNotes() as Record<string, TFile>;
    const today = moment().startOf('day');
    const pool = Object.values(allNotes).filter((f): f is TFile => {
      if (!(f instanceof TFile)) return false;
      const d = getDateFromFile(f, 'day');
      return !!d && d.isBefore(today, 'day');
    });

    if (pool.length === 0) {
      this.disposeDays();
      this.timelineEl.empty();
      this.renderTopLevelMessage(t('search.noPastEntries'));
      return;
    }

    // Leave normal search mode — clear query/input and switch into random mode
    this.searchQuery = '';
    this.searchInputEl.value = '';
    this.exhausted = true;
    this.searchFileQueue = [];
    this.searchCursor = 0;

    let entry: JournalEntry | null = null;
    let pickedFile: TFile | null = null;
    let pickedDate: moment.Moment | null = null;

    while (pool.length > 0 && !entry) {
      const idx = Math.floor(Math.random() * pool.length);
      const file = pool.splice(idx, 1)[0];
      try {
        const content = await this.app.vault.cachedRead(file);
        const section = findSection(content, this.plugin.settings.targetHeading, this.plugin.settings.headingLevel);
        if (!section) continue;
        const text = content.slice(section.from, section.to);
        let entries = parseJournalEntries(text, this.plugin.settings.timestampPattern);
        if (entries.length === 0) entries = this.parseLooseEntries(text);
        if (entries.length === 0) continue;
        entry = entries[Math.floor(Math.random() * entries.length)];
        pickedFile = file;
        pickedDate = getDateFromFile(file, 'day')!.clone().startOf('day');
      } catch (err) {
        console.error('[Spark Memo] random memo read failed', err);
      }
    }

    this.disposeDays();
    this.timelineEl.empty();

    if (!entry || !pickedFile || !pickedDate) {
      this.renderTopLevelMessage(t('search.noRandomMemo'));
      return;
    }

    const day: DaySection = {
      date: pickedDate,
      el: createDiv({ cls: 'jp-timeline-day' }),
      scope: new Component(),
      filePath: pickedFile.path,
    };
    day.scope.load();
    this.renderRandomMemoContent(day, entry);
    this.timelineEl.appendChild(day.el);
    this.days.push(day);
  }

  /** Render a single randomly-picked entry. Re-roll lives in the search bar's dice button, not here. */
  private renderRandomMemoContent(day: DaySection, entry: JournalEntry) {
    const headerRow = day.el.createDiv({ cls: 'jp-timeline-entry jp-timeline-entry--header' });
    headerRow.createDiv({ cls: 'jp-timeline-dot jp-timeline-dot--header' });
    const headerCard = headerRow.createDiv({ cls: 'jp-timeline-header-card' });
    const headerText = headerCard.createDiv({ cls: 'jp-timeline-header-text' });
    headerText.createEl('div', { cls: 'jp-timeline-header-title', text: t('search.randomMemoLabel') });
    const jumpBtn = headerCard.createEl('button', {
      cls: 'jp-timeline-open-btn',
      attr: { 'aria-label': t('capture.jumpToDay'), title: t('capture.jumpToDay') },
    });
    setIcon(jumpBtn, 'crosshair');
    jumpBtn.addEventListener('click', () => {
      this.currentDate = day.date.clone().startOf('day');
      if (this.currentTab === 'capture') {
        void this.fullRebuild();
      } else {
        this.switchTab('capture');
      }
    });

    const sourcePath = day.filePath ?? '';
    const row = day.el.createDiv({ cls: 'jp-timeline-entry' });
    row.createDiv({ cls: 'jp-timeline-dot' });
    const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
    // Special-cased here only: since the heavy date/weekday header above is
    // gone, the timestamp badge carries the date itself so it's still clear
    // which day this randomly-picked entry came from.
    const isCurrentYear = day.date.year() === moment().year();
    const dateTimeLabel = `${day.date.format(isCurrentYear ? 'M/D' : 'YYYY/M/D')} ${entry.timestamp}`;
    head.createEl('span', { cls: 'jp-timestamp', text: dateTimeLabel });
    const { text: bodyText, location } = extractLocationTag(entry.text);
    if (location) this.renderLocationChip(head, day, entry, location);
    const bubble = row.createDiv({ cls: 'jp-timeline-bubble' });
    void MarkdownRenderer.render(this.app, bodyText, bubble, sourcePath, day.scope).then(() => {
      this.applyImageGrid(bubble);
      this.attachImagePreviews(bubble);
      this.attachTagClickHandlers(bubble);
    });

    const openMenu = (evt: MouseEvent) => {
      evt.preventDefault();
      this.openEntryMenu(evt, day, entry);
    };
    head.addEventListener('contextmenu', openMenu);
    bubble.addEventListener('contextmenu', openMenu);
  }

  /**
   * Loose parser: treat every top-level list item as an entry timestamped 00:00.
   * Used when the section has no standard `- HH:MM ...` format.
   */
  private parseLooseEntries(sectionText: string): Array<{ timestamp: string; text: string; lineIndex: number }> {
    const result: Array<{ timestamp: string; text: string; lineIndex: number }> = [];
    const lines = sectionText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^[-*+]\s+(.+)$/);
      if (!m) continue;
      let text = m[1].trim();
      // Collect indented continuation lines
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        text += '\n' + lines[j].replace(/^\s{0,2}/, '');
        j++;
      }
      result.push({ timestamp: '00:00', text, lineIndex: i });
    }
    return result;
  }

  // ── Stats pane ──────────────────────────────────────────────────────────

  /** Build the static scaffold of the stats pane (toolbar + body). */
  private buildStatsPane() {
    // Toolbar with title
    this.statsToolbarEl = this.statsPaneEl.createDiv({ cls: 'jp-stats-toolbar' });

    this.statsToolbarEl.createDiv({ cls: 'jp-stats-toolbar-spacer' });

    this.statsYearLabelEl = this.statsToolbarEl.createDiv({
      cls: 'jp-stats-year-label',
      text: t('stats.yearLabel', { year: String(moment().year()) }),
    });

    // Body container
    this.statsBodyEl = this.statsPaneEl.createDiv({ cls: 'jp-stats-body' });
  }

  /** Debounced reload, used in response to vault mutations. */
  private scheduleStatsRefresh() {
    // Only refresh if the user has at least opened the tab once. Otherwise
    // every memo save would do hidden work the user never sees.
    if (this.statsPaneEl.childElementCount === 0) return;
    if (this.statsRefreshTimer !== null) {
      window.clearTimeout(this.statsRefreshTimer);
    }
    this.statsRefreshTimer = window.setTimeout(() => {
      this.statsRefreshTimer = null;
      void this.loadAllStats();
    }, 300);
  }

  /**
   * Marks the year a daily-note file belongs to as needing a rescan on the
   * next `loadAllStats` pass. A no-op once a full rescan (`dirtyYears ===
   * null`) is already pending — no point tracking individual years then.
   */
  private markStatsDirtyForFile(file: TFile): void {
    if (this.dirtyYears === null) return;
    const d = getDateFromFile(file, 'day');
    if (d) this.dirtyYears.add(d.year());
  }

  /**
   * Load + render stats across every year of journal history in the vault.
   *
   * Only years listed in `dirtyYears` are actually re-read from disk; every
   * other year reuses its cached `YearStats` / city set from the previous
   * pass. `dirtyYears === null` forces a full rescan (first load, or after a
   * rename we can't attribute to one year).
   */
  private async loadAllStats(): Promise<void> {
    if (this.statsLoading) return;
    this.statsLoading = true;

    this.renderStatsLoading();

    try {
      if (!appHasDailyNotesPluginLoaded()) {
        this.renderStatsError(t('notice.dailyNotesRequired'));
        return;
      }

      const fullRescan = this.dirtyYears === null;
      const yearsToScan = this.dirtyYears;

      const all = getAllDailyNotes() as Record<string, TFile>;
      const yearMap = new Map<number, Array<{ key: string; sectionText: string }>>();
      const yearCitiesUpdate = new Map<number, Set<string>>();

      for (const file of Object.values(all)) {
        if (!(file instanceof TFile)) continue;
        const d = getDateFromFile(file as TFile, 'day');
        if (!d) continue;
        const year = d.year();
        // Cheap to determine (no disk read) — only years actually touched
        // since the last pass get the expensive cachedRead below.
        if (!fullRescan && !yearsToScan!.has(year)) continue;
        const key = d.format('YYYY-MM-DD');

        let sectionText = '';
        try {
          const content = await this.app.vault.cachedRead(file);
          const section = findSection(
            content,
            this.plugin.settings.targetHeading,
            this.plugin.settings.headingLevel,
          );
          if (section) {
            sectionText = content.slice(section.from, section.to);
          }
        } catch (err) {
          console.error('[Spark Memo] stats read failed', file.path, err);
        }

        if (!yearMap.has(year)) yearMap.set(year, []);
        yearMap.get(year)!.push({ key, sectionText });

        if (!yearCitiesUpdate.has(year)) yearCitiesUpdate.set(year, new Set());
        const citySet = yearCitiesUpdate.get(year)!;
        for (const m of sectionText.matchAll(LOCATION_TAG_RE_GLOBAL)) citySet.add(m[1]);
      }

      // Years we actually rescanned this pass — full rescan means every year
      // present in the vault; otherwise just the previously-dirty ones.
      const rescannedYears = fullRescan ? [...yearMap.keys()] : [...yearsToScan!];
      for (const year of rescannedYears) {
        const dayInputs = yearMap.get(year);
        if (!dayInputs || dayInputs.length === 0) {
          // Last daily note for this year is gone — drop it from the cache
          // rather than leaving stale (or zeroed) stats behind.
          this.allYearStats.delete(year);
          this.yearCities.delete(year);
          continue;
        }
        const ys = computeYearStats(year, dayInputs, this.plugin.settings.timestampPattern);
        this.allYearStats.set(year, ys);
        this.yearCities.set(year, yearCitiesUpdate.get(year) ?? new Set());
      }
      this.dirtyYears = new Set();

      // Merge distinct cities across every cached year.
      const allCities = new Set<string>();
      for (const set of this.yearCities.values()) {
        for (const name of set) allCities.add(name);
      }
      this.statsLocationCount = allCities.size;

      // Compute all-time stats
      this.allTimeStats = computeAllTimeStats([...this.allYearStats.values()]);

      this.renderStatsContent();
    } catch (err) {
      console.error('[Spark Memo] stats load failed', err);
      this.renderStatsError(t('stats.loadFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.statsLoading = false;
    }
  }

  /**
   * Scan every daily note in `year` and return per-day raw journal-section text.
   *
   * The stats layer works off raw section text (not parsed entries) so we
   * can count plain-paragraph memos from older journals that never used the
   * `- HH:MM ...` convention. Days whose section is empty (or whose file
   * has no `## Journal` heading at all) still appear in the result with an
   * empty string, so the heatmap can render them as level-0.
   */
  private renderStatsLoading() {
    this.statsBodyEl.empty();
    const loading = this.statsBodyEl.createDiv({ cls: 'jp-stats-loading' });
    loading.createDiv({ cls: 'jp-stats-spinner' });
    loading.createDiv({
      text: t('stats.loadingData'),
      cls: 'jp-stats-loading-text',
    });
  }

  private renderStatsError(msg: string) {
    this.statsBodyEl.empty();
    this.statsBodyEl.createDiv({ cls: 'jp-stats-empty', text: msg });
  }

  private renderStatsContent() {
    this.statsBodyEl.empty();
    const allTime = this.allTimeStats;
    if (!allTime) return;

    // ── All-time hero ────────────────────────────────────────────────────
    const hero = this.statsBodyEl.createDiv({ cls: 'jp-stats-hero' });
    const top = hero.createDiv({ cls: 'jp-stats-hero-top' });

    const numLine = top.createDiv({ cls: 'jp-stats-hero-number' });
    const formatted = formatWordCount(allTime.totalWords, currentLocale());
    if (formatted.includes('万')) {
      const [num, unit] = formatted.split(' ');
      numLine.createSpan({ cls: 'jp-stats-hero-num', text: num });
      numLine.createSpan({ cls: 'jp-stats-hero-unit', text: unit });
    } else {
      numLine.createSpan({ cls: 'jp-stats-hero-num', text: formatted });
      numLine.createSpan({ cls: 'jp-stats-hero-unit', text: t('stats.unit.words') });
    }

    const sub = top.createDiv({ cls: 'jp-stats-hero-sub' });
    const firstYear = allTime.yearsWithData[0];
    const lastYear = allTime.yearsWithData[allTime.yearsWithData.length - 1];
    const yearsStr = allTime.yearsWithData.length === 0
      ? t('stats.noData')
      : firstYear === lastYear
        ? t('stats.allRecordsSingleYear', { year: String(firstYear) })
        : t('stats.allRecordsYearRange', { first: String(firstYear), last: String(lastYear) });
    sub.createSpan({ text: yearsStr });

    const grid = hero.createDiv({ cls: 'jp-stats-hero-kpis' });
    this.makeStatsKPI(grid, 'file-text', `${allTime.writingDays}`, t('stats.unit.days'), t('stats.writingDays'));
    this.makeStatsKPI(grid, 'pencil', `${allTime.totalEntries}`, t('stats.unit.entries'), t('stats.totalEntries'));
    this.makeStatsKPI(grid, 'flame', `${allTime.longestStreak}`, t('stats.unit.days'), t('stats.longestStreak'));
    this.makeStatsKPI(grid, 'map-pin', `${this.statsLocationCount}`, t('stats.unit.places'), t('stats.visitedLocations'));

    // ── Per-year heatmaps ─────────────────────────────────────────────────
    // `allYearStats` includes any year with at least one daily-note *file*
    // (even one whose journal section is empty — e.g. an auto-created blank
    // note). Only years with actual writing belong here, so filter down to
    // `yearsWithData` — the same "has content" check `computeAllTimeStats`
    // already applied.
    const yearsWithData = new Set(allTime.yearsWithData);
    const years = [...this.allYearStats.keys()]
      .filter(year => yearsWithData.has(year))
      .sort((a, b) => b - a);
    for (const year of years) {
      const ys = this.allYearStats.get(year)!;
      this.renderStatsHeatmapSection(year, ys);
    }
  }

  private makeStatsKPI(
    parent: HTMLElement,
    icon: string,
    value: string,
    unit: string,
    label: string,
  ) {
    const card = parent.createDiv({ cls: 'jp-stats-kpi-card' });
    const iconEl = card.createDiv({ cls: 'jp-stats-kpi-icon' });
    setIcon(iconEl, icon);
    const row = card.createDiv({ cls: 'jp-stats-kpi-row' });
    row.createSpan({ cls: 'jp-stats-kpi-value', text: value });
    if (unit) row.createSpan({ cls: 'jp-stats-kpi-unit', text: unit });
    card.createDiv({ cls: 'jp-stats-kpi-label', text: label });
  }

  private renderStatsHeatmapSection(year: number, stats: YearStats) {
    const section = this.statsBodyEl.createDiv({ cls: 'jp-stats-heatmap-section' });

    const header = section.createDiv({ cls: 'jp-stats-heatmap-header' });
    header.createDiv({ cls: 'jp-stats-heatmap-title', text: t('stats.yearLabel', { year: String(year) }) });

    this.renderStatsHeatmap(
      section.createDiv({ cls: 'jp-stats-heatmap-wrap' }),
      stats,
    );

    // Legend
    const legend = section.createDiv({ cls: 'jp-stats-legend' });
    legend.createSpan({ cls: 'jp-stats-legend-label', text: t('stats.legendLess') });
    for (let l = 0; l <= 4; l++) {
      legend.createDiv({ cls: `jp-stats-cell level-${l}` });
    }
    legend.createSpan({ cls: 'jp-stats-legend-label', text: t('stats.legendMore') });

    // Footer summary
    const footer = section.createDiv({ cls: 'jp-stats-footer' });
    footer.setText(
      t('stats.footerSummary', {
        days: String(stats.writingDays),
        words: stats.totalWords.toLocaleString('en-US'),
        entries: String(stats.totalEntries),
      }) + (stats.totalAudios > 0 ? t('stats.footerAudioSuffix', { count: String(stats.totalAudios) }) : ''),
    );
  }

  private renderStatsHeatmap(parent: HTMLElement, stats: YearStats) {
    const year = stats.year;
    const today = moment().startOf('day');

    // All days of the year (date + per-day counts).
    const allDays: { date: moment.Moment; entryCount: number; wordCount: number }[] = [];
    const start = moment({ year, month: 0, day: 1 }).startOf('day');
    const end = moment({ year, month: 11, day: 31 }).startOf('day');
    for (let d = start.clone(); d.isSameOrBefore(end); d.add(1, 'day')) {
      const ds = stats.dailyMap.get(d.format('YYYY-MM-DD'));
      allDays.push({
        date: d.clone(),
        entryCount: ds?.entryCount ?? 0,
        wordCount: ds?.wordCount ?? 0,
      });
    }

    // Pad to a Monday-start grid. Sunday (0) becomes index 6, Monday (1)
    // becomes 0, etc. Matches the "一/三/五" weekday labels.
    const firstDow = allDays[0].date.day();
    const startPad = firstDow === 0 ? 6 : firstDow - 1;
    const paddedDays: (typeof allDays[number] | null)[] = [
      ...Array(startPad).fill(null),
      ...allDays,
    ];
    const totalWeeks = Math.ceil(paddedDays.length / 7);

    // First week each month appears in (for the month-label row).
    const monthWeek: Record<number, number> = {};
    for (let w = 0; w < totalWeeks; w++) {
      for (let dow = 0; dow < 7; dow++) {
        const item = paddedDays[w * 7 + dow];
        if (!item) continue;
        const mo = item.date.month();
        if (!(mo in monthWeek)) monthWeek[mo] = w;
      }
    }

    const inner = parent.createDiv({ cls: 'jp-stats-heatmap-inner' });

    // Weekday labels column
    const labelsCol = inner.createDiv({ cls: 'jp-stats-daylabels' });
    const dayLabels: Record<number, string> = { 0: t('stats.weekdayMon'), 2: t('stats.weekdayWed'), 4: t('stats.weekdayFri') };
    for (let i = 0; i < 7; i++) {
      labelsCol.createDiv({ cls: 'jp-stats-daylabel', text: dayLabels[i] ?? '' });
    }

    const rightCol = inner.createDiv({ cls: 'jp-stats-heatmap-right' });

    // Month-label row
    const monthRow = rightCol.createDiv({ cls: 'jp-stats-monthrow' });
    for (let w = 0; w < totalWeeks; w++) {
      const entry = Object.entries(monthWeek).find(([, wk]) => wk === w);
      const monthLabel = entry
        ? currentLocale() === 'zh'
          ? `${Number(entry[0]) + 1}月`
          : moment().month(Number(entry[0])).format('MMM')
        : '';
      monthRow.createDiv({ cls: 'jp-stats-monthlabel', text: monthLabel });
    }

    // Cell grid
    const grid = rightCol.createDiv({ cls: 'jp-stats-grid' });

    for (let w = 0; w < totalWeeks; w++) {
      const col = grid.createDiv({ cls: 'jp-stats-col' });
      for (let dow = 0; dow < 7; dow++) {
        const item = paddedDays[w * 7 + dow];
        if (!item) {
          col.createDiv({ cls: 'jp-stats-cell is-empty' });
          continue;
        }
        const { date, entryCount, wordCount } = item;
        const level = getHeatmapLevel(entryCount);
        const isToday = date.isSame(today, 'day');
        const isFuture = date.isAfter(today, 'day');
        const classes =
          `jp-stats-cell level-${level}` +
          (isToday ? ' is-today' : '') +
          (isFuture ? ' is-future' : '');
        const cell = col.createDiv({ cls: classes });

        const label = date.format(t('stats.cellDateFormat'));
        if (entryCount > 0) {
          cell.setAttr('title', t('stats.cellTitleWithData', { date: label, entries: String(entryCount), words: String(wordCount) }));
        } else {
          cell.setAttr('title', isFuture ? label : t('stats.cellTitleNoData', { date: label }));
        }

        if (!isFuture) {
          cell.addEventListener('click', () => {
            this.currentDate = date.clone().startOf('day');
            if (this.currentTab === 'capture') {
              void this.fullRebuild();
            } else {
              this.switchTab('capture');
            }
          });
        }
      }
    }
  }

  /** Add a locate button to the right side of a day header card, jumping to that day in the capture timeline. */
  private addOpenNoteBtn(headerCard: HTMLElement, day: DaySection) {
    if (!day.filePath) return;
    const btn = headerCard.createEl('button', {
      cls: 'jp-timeline-open-btn',
      attr: { 'aria-label': t('capture.jumpToDay'), title: t('capture.jumpToDay') },
    });
    setIcon(btn, 'crosshair');
    btn.addEventListener('click', () => {
      this.currentDate = day.date.clone().startOf('day');
      if (this.currentTab === 'capture') {
        void this.fullRebuild();
      } else {
        this.switchTab('capture');
      }
    });
  }

  // ── Mobile toolbar auto-hide ────────────────────────────────────────────

  /**
   * On mobile, hide Obsidian's bottom toolbar (`.mobile-toolbar`) when the
   * user scrolls down (looking at older entries) and reveal it when they
   * scroll up. Restores the toolbar on view close so we never leave it in
   * a hidden state when the user navigates away.
   */
  private setupMobileToolbarAutoHide() {
    if (!Platform.isMobile) return;
    const scroller = this.containerEl.children[1] as HTMLElement;
    if (!scroller) return;

    this.scrollEl = scroller;
    this.lastScrollTop = scroller.scrollTop;

    this.onScrollBound = () => {
      const top = scroller.scrollTop;
      const delta = top - this.lastScrollTop;

      if (Math.abs(delta) < this.scrollDeltaThreshold) return;

      // Always show near the top — feels less abrupt when the user lands
      // back on today's entries.
      if (top <= 8) {
        this.setToolbarHidden(false);
      } else if (delta > 0) {
        // Scrolling down → hide
        this.setToolbarHidden(true);
      } else {
        // Scrolling up → show
        this.setToolbarHidden(false);
      }

      this.lastScrollTop = top;
    };

    scroller.addEventListener('scroll', this.onScrollBound, { passive: true });
  }

  private teardownMobileToolbarAutoHide() {
    if (this.scrollEl && this.onScrollBound) {
      this.scrollEl.removeEventListener('scroll', this.onScrollBound);
    }
    this.scrollEl = null;
    this.onScrollBound = null;
    // Always restore on close — never leave the user without their toolbar.
    this.setToolbarHidden(false);
  }

  private setToolbarHidden(hidden: boolean) {
    document.body.toggleClass('jp-hide-mobile-toolbar', hidden);
  }

  // ── Entry context menu (copy / edit / delete) ────────────────────────────

  /**
   * Build and show the right-click / long-press context menu for one entry.
   * Items shown:
   *   - 复制                — copies the raw markdown body to clipboard
   *   - 编辑                — loads the entry's text back into the input box
   *   - 删除 memo           — deletes only the entry line(s) from the daily note
   *   - 仅删除录音文件       — keeps the memo text, trashes audio + strips ![[..]]
   *
   * The audio-related item is only added when the entry actually
   * embeds at least one audio attachment (`![[*.m4a]]` etc.).
   */
  private openEntryMenu(evt: MouseEvent, day: DaySection, entry: JournalEntry) {
    const menu = new Menu();
    const audioPaths = extractAudioEmbeds(entry.text);

    menu.addItem(item =>
      item
        .setTitle(t('capture.menuCopy'))
        .setIcon('copy')
        .onClick(() => {
          void this.copyEntry(entry);
        }),
    );

    menu.addItem(item =>
      item
        .setTitle(t('capture.menuEdit'))
        .setIcon('pencil')
        .onClick(() => {
          void this.startEdit(day, entry);
        }),
    );

    menu.addSeparator();

    menu.addItem(item =>
      item
        .setTitle(t('capture.menuDeleteMemo'))
        .setIcon('trash-2')
        .onClick(() => {
          const mode: DeleteMode = audioPaths.length > 0 ? 'memo+audio' : 'memo';
          this.confirmAndDelete(day, entry, mode, audioPaths);
        }),
    );

    if (audioPaths.length > 0) {
      menu.addItem(item =>
        item
          .setTitle(
            audioPaths.length === 1
              ? t('capture.menuDeleteAudioOnlySingle')
              : t('capture.menuDeleteAudioOnlyMulti', { count: String(audioPaths.length) }),
          )
          .setIcon('mic-off')
          .onClick(() => {
            this.confirmAndDelete(day, entry, 'audio-only', audioPaths);
          }),
      );
    }

    menu.showAtMouseEvent(evt);
  }

  /** Copy the raw markdown body of the entry (without `- HH:MM` prefix). */
  private async copyEntry(entry: JournalEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(entry.text);
      notice(t('notice.copied'));
    } catch (err) {
      console.error('[Spark Memo] copy failed', err);
      notice(t('notice.copyFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /**
   * Show a confirmation modal listing what will be deleted, then execute
   * the deletion on confirm.
   *
   * Audio files are moved to Obsidian's configured trash via
   * `fileManager.trashFile` so they remain recoverable regardless of which
   * mode is picked.
   */
  private confirmAndDelete(
    day: DaySection,
    entry: JournalEntry,
    mode: DeleteMode,
    audioPaths: string[],
  ) {
    const run = () => {
      void this.executeDelete(day, entry, mode, audioPaths);
    };

    new DeleteConfirmModal(this.app, {
      title:
        mode === 'memo'
          ? t('capture.menuDeleteMemo')
          : mode === 'memo+audio'
            ? t('capture.deleteMemoAndAudioTitle')
            : t('capture.deleteAudioOnlyTitle'),
      preview: this.buildEntryPreview(entry),
      timestamp: entry.timestamp,
      audioPaths: mode === 'memo' ? [] : audioPaths,
      mode,
      onConfirm: run,
    }).open();
  }

  /** Compact preview text for the confirm modal (≤ 80 chars, single line). */
  private buildEntryPreview(entry: JournalEntry): string {
    const raw = entry.text.replace(/\s+/g, ' ').trim();
    return raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
  }

  /**
   * Perform the actual deletion. Rewrites the daily note via
   * `vault.modify`, then (when relevant) trashes audio files. Audio
   * failures are logged but don't roll back the text deletion — they're
   * independent pieces of state and the user explicitly opted into both.
   *
   * Modes:
   *   - 'memo'       : drop entry head + continuation lines
   *   - 'memo+audio' : same as above, plus trash audio files
   *   - 'audio-only' : keep memo text but strip ![[...]] audio embeds,
   *                    plus trash audio files
   */
  private async executeDelete(
    day: DaySection,
    entry: JournalEntry,
    mode: DeleteMode,
    audioPaths: string[],
  ): Promise<void> {
    if (!day.filePath) {
      notice(t('notice.journalFileNotFound'));
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(day.filePath);
    if (!(file instanceof TFile)) {
      notice(t('notice.journalFileNotFound'));
      return;
    }

    try {
      const content = await this.app.vault.read(file);
      const next =
        mode === 'audio-only'
          ? removeAudioEmbedsFromEntry(content, this.plugin.settings, entry.lineIndex)
          : deleteEntryFromSection(content, this.plugin.settings, entry.lineIndex);
      if (next === content) {
        // No-op means our lineIndex no longer matches a head line — the file
        // changed under us. Refresh and bail rather than mangling content.
        notice(t('notice.journalChangedRetry'));
        await this.refreshDay(day);
        return;
      }
      await this.app.vault.modify(file, next);
    } catch (err) {
      console.error('[Spark Memo] delete entry failed', err);
      notice(t('notice.deleteFailed', { error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // Trash embedded audio files when the mode calls for it.
    const trashAudio = mode === 'memo+audio' || mode === 'audio-only';
    let trashed = 0;
    let missing = 0;
    if (trashAudio) {
      for (const path of audioPaths) {
        const af = this.app.vault.getAbstractFileByPath(path);
        if (!(af instanceof TFile)) {
          missing++;
          continue;
        }
        try {
          await this.app.fileManager.trashFile(af);
          trashed++;
        } catch (err) {
          console.error(`[Spark Memo] trash audio failed: ${path}`, err);
        }
      }
    }

    // User-visible toast — tuned per mode so the message is unambiguous.
    if (mode === 'memo') {
      notice(t('notice.memoDeleted'));
    } else if (mode === 'memo+audio') {
      if (missing === audioPaths.length) {
        notice(t('notice.memoDeletedAudioMissing'));
      } else if (trashed === audioPaths.length) {
        notice(t('notice.memoAndAudioDeleted', { count: String(trashed) }));
      } else {
        notice(t('notice.memoDeletedAudioPartial', { trashed: String(trashed), total: String(audioPaths.length) }));
      }
    } else {
      // audio-only
      if (missing === audioPaths.length) {
        notice(t('notice.audioLinkRemovedMissing'));
      } else if (trashed === audioPaths.length) {
        notice(t('notice.audioDeleted', { count: String(trashed) }));
      } else {
        notice(t('notice.audioLinkRemovedPartial', { trashed: String(trashed), total: String(audioPaths.length) }));
      }
    }
  }

  // ── Submit / write path ─────────────────────────────────────────────────

  private async handleSubmit(): Promise<void> {
    const text = this.textareaEl.value;
    if (text.trim().length === 0 && this.pendingImages.length === 0 && this.pendingAudio.length === 0) return;

    const locationTag = this.pendingLocation
      ? ` [${this.pendingLocation.name ?? t('location.placeholder')}](geo:${this.pendingLocation.latitude.toFixed(6)},${this.pendingLocation.longitude.toFixed(6)})`
      : '';
    const bodyText = locationTag ? `${text}${locationTag}` : text;

    const embeds = [
      ...this.pendingImages.map(file => `![[${file.path}]]`),
      ...this.pendingAudio.map(a => `![[${a.file.path}]]`),
    ].join(' ');
    const raw = embeds
      ? (bodyText.trim().length > 0 ? `${bodyText}\n${embeds}` : embeds)
      : bodyText;

    if (!appHasDailyNotesPluginLoaded()) {
      notice(t('notice.dailyNotesRequired'));
      return;
    }

    this.submitBtn.disabled = true;
    this.submitBtn.addClass('jp-capture-submit--disabled');
    this.submitBtn.addClass('jp-capture-submit--loading');
    setIcon(this.submitBtn, 'loader-2');

    try {
      if (this.editingEntry) {
        const ok = await this.updateEditedEntry(raw);
        if (!ok) return;

        this.editingEntry = null;
        this.textareaEl.value = '';
        this.textareaEl.placeholder = this.pickRandomPlaceholder();
        this.pendingImages = [];
        this.pendingAudio = [];
        this.pendingCaptureOverride = null;
        this.pendingLocation = null;
        this.pendingMetadataHint = null;
        this.lastAppliedMetadata = null;
        this.renderAttachmentList();
        this.renderCaptureTimePill();
        this.renderLocationPill();
        this.renderMetadataHintPill();
        this.renderEditingPill();
        this.autoResizeTextarea();
        notice(t('notice.memoUpdated'));
        return;
      }

      const targetDate = this.pendingCaptureOverride?.date;
      const ok = await this.plugin.writeJournalEntry(
        raw,
        this.pendingCaptureOverride?.time,
        undefined,
        targetDate,
      );
      if (!ok) return;

      const writtenDay = (targetDate ?? moment()).clone().startOf('day');

      this.textareaEl.value = '';
      this.textareaEl.placeholder = this.pickRandomPlaceholder();
      this.pendingImages = [];
      this.pendingAudio = [];
      this.pendingCaptureOverride = null;
      this.pendingLocation = null;
      this.pendingMetadataHint = null;
      this.lastAppliedMetadata = null;
      this.renderAttachmentList();
      this.renderCaptureTimePill();
      this.renderLocationPill();
      this.renderMetadataHintPill();
      this.autoResizeTextarea();

      // vault.modify will catch-up an already-loaded day's section
      // automatically; if the written day wasn't mounted (e.g. plugin just
      // opened with no file, or the entry was backdated to an image's
      // capture date beyond the loaded window), trigger a full rebuild so
      // it appears.
      const loadedDay = this.days.find(d => d.date.isSame(writtenDay, 'day'));
      if (!loadedDay) {
        await this.fullRebuild();
      }

      if (writtenDay.isSame(moment(), 'day')) {
        // Scroll to top so user sees the new entry land
        const scroller = this.containerEl.children[1] as HTMLElement;
        scroller.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        notice(t('notice.recordedToDate', { date: writtenDay.format('YYYY-MM-DD') }));
      }
    } catch (err) {
      console.error('[Spark Memo] submit failed', err);
      notice(t('notice.writeFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.submitBtn.removeClass('jp-capture-submit--loading');
      setIcon(this.submitBtn, 'arrow-up');
      this.refreshSubmitState();
    }
  }

  /**
   * Rewrites the entry currently being edited (see `startEdit`) in place,
   * preserving its original timestamp — unless the user applied a photo's
   * EXIF capture time via `pendingCaptureOverride` while editing, in which
   * case that time replaces it (only when the photo's date matches the day
   * this entry already lives in; editing can't move an entry to a different
   * day's note). Returns false (with a Notice already shown) on failure or
   * if the underlying file changed under us since the menu was opened.
   */
  private async updateEditedEntry(raw: string): Promise<boolean> {
    const { day, entry } = this.editingEntry!;
    if (!day.filePath) {
      notice(t('notice.journalFileNotFound'));
      return false;
    }
    const file = this.app.vault.getAbstractFileByPath(day.filePath);
    if (!(file instanceof TFile)) {
      notice(t('notice.journalFileNotFound'));
      return false;
    }

    const override = this.pendingCaptureOverride;
    const newTimestamp = override && override.date.isSame(day.date, 'day')
      ? override.time
      : undefined;

    try {
      const content = await this.app.vault.read(file);
      const next = replaceEntryTextInSection(
        content,
        this.plugin.settings,
        entry.lineIndex,
        entry.timestamp,
        raw,
        newTimestamp,
      );
      if (next === content) {
        notice(t('notice.journalChangedRetry'));
        await this.refreshDay(day);
        return false;
      }
      await this.app.vault.modify(file, next);
      return true;
    } catch (err) {
      console.error('[Spark Memo] update entry failed', err);
      notice(t('notice.updateFailed', { error: err instanceof Error ? err.message : String(err) }));
      return false;
    }
  }
}

/** Human-readable file size, e.g. 512 → "512 B", 2_400_000 → "2.4 MB". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Location tag helpers ────────────────────────────────────────────────────

/** A `[城市名](geo:lat,lon)` tag extracted out of an entry's stored text. */
interface EntryLocation {
  name: string;
  latitude: number;
  longitude: number;
}

const LOCATION_TAG_RE = /\s*\[([^\]]*)\]\(geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/;
/** Global variant of {@link LOCATION_TAG_RE}, used to tally distinct cities across a section. */
const LOCATION_TAG_RE_GLOBAL = /\[([^\]]*)\]\(geo:-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\)/g;

/**
 * Pulls the trailing `[城市名](geo:lat,lon)` tag (written by `handleSubmit`)
 * out of an entry's raw text, so it can be rendered as its own pill next to
 * the timestamp instead of as an inline Markdown link inside the body.
 */
function extractLocationTag(text: string): { text: string; location: EntryLocation | null } {
  const m = LOCATION_TAG_RE.exec(text);
  if (!m) return { text, location: null };
  const location: EntryLocation = { name: m[1], latitude: Number(m[2]), longitude: Number(m[3]) };
  return { text: text.slice(0, m.index) + text.slice(m.index + m[0].length), location };
}

// ── Hashtag helpers (tag-aggregation tab) ───────────────────────────────────

/**
 * `#tag` occurrences inside an entry's body — any-script letters/numbers plus
 * -/_// (nested tags), matching Obsidian's own tag syntax (see the compose-box
 * tag-suggest popup, which validates against the same rules). Purely numeric
 * matches (e.g. "#2026") are excluded since Obsidian doesn't recognize those
 * as tags either.
 */
/** Distinct `#tag` names (deduped, `#`-prefixed) found in an entry's text. */
function extractEntryTags(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(TAG_TOKEN_RE)) {
    const raw = m[2];
    if (/^\p{N}+$/u.test(raw)) continue;
    seen.add(`#${raw}`);
  }
  return [...seen];
}


// ── Image capture-time helpers ──────────────────────────────────────────────

/**
 * Best-effort "when was this photo taken": EXIF DateTimeOriginal for JPEGs,
 * falling back to the file's last-modified time (meaningful for drag/dropped
 * or file-picker-selected files; a pasted screenshot's lastModified is
 * essentially "now", so it won't spuriously trigger the mismatch prompt).
 */
async function getImageCaptureTime(file: File): Promise<Date | null> {
  if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
    try {
      const buffer = await file.arrayBuffer();
      const exifDate = readExifCaptureDate(buffer);
      if (exifDate) return exifDate;
    } catch {
      // fall through to lastModified
    }
  }
  return file.lastModified ? new Date(file.lastModified) : null;
}

/**
 * Asks whether to use whichever of {capture time, GPS location} was found
 * on the picked photo(s). Resolves `true` only on an explicit "使用图片
 * 信息" click — dismissing (Esc / click-outside / "不使用") resolves
 * `false` and leaves both "now" and "no location" untouched.
 */
interface ImageMetadataLocation {
  /** `null` while reverse geocoding hasn't produced a name yet, or has failed. */
  name: string | null;
  latitude: number;
  longitude: number;
}

interface ImageMetadataConfirmResult {
  useImageInfo: boolean;
  /** The location as last left in the modal — reflects any successful "重试" click. */
  location: ImageMetadataLocation | null;
}

interface ImageMetadataConfirmOptions {
  /** `null` when no capture time was found, or it didn't differ from "now" by more than 5 minutes. */
  capturedAt: Date | null;
  diffMinutes: number;
  /** `null` when no GPS coordinate was found on any picked photo. `name` starts `null` — filled in later via `setLocationName`. */
  location: ImageMetadataLocation | null;
}

class ImageMetadataConfirmModal extends Modal {
  private opts: ImageMetadataConfirmOptions;
  private resolve: (result: ImageMetadataConfirmResult) => void;
  private decided = false;
  /** Mutable copy of `opts.location` — "重试" (or the initial background geocode) updates `.name` in place. */
  private location: ImageMetadataLocation | null;
  private locationLi: HTMLElement | null = null;
  /** True while a name lookup is in flight — either the initial background geocode or a manual "重试". Suppresses the "查找失败" wording and disables the retry button. */
  private retrying: boolean;

  constructor(
    app: import('obsidian').App,
    opts: ImageMetadataConfirmOptions,
    resolve: (result: ImageMetadataConfirmResult) => void,
    resolvingLocationName = false,
  ) {
    super(app);
    this.opts = opts;
    this.resolve = resolve;
    this.location = opts.location;
    this.retrying = resolvingLocationName;
  }

  /**
   * Fills in the place name once the background reverse-geocode (kicked off
   * alongside opening this modal, so the modal itself isn't delayed by the
   * network round-trip) resolves. No-op if the modal was already decided,
   * or a manual "重试" has since taken over.
   */
  setLocationName(name: string | null): void {
    if (this.decided || !this.location || !this.retrying) return;
    this.retrying = false;
    this.location.name = name;
    this.renderLocationLine();
  }

  private decide(useImageInfo: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve({ useImageInfo, location: this.location });
    this.close();
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    const { capturedAt, location } = this.opts;
    const hasBoth = capturedAt !== null && location !== null;
    titleEl.setText(
      hasBoth ? t('capture.metadataModalTitleBoth')
        : capturedAt !== null ? t('capture.metadataModalTitleTimeOnly')
          : t('capture.metadataModalTitleLocationOnly'),
    );
    titleEl.addClass('jp-modal-title-flush');
    contentEl.addClass('jp-image-time-confirm');

    contentEl.createEl('p', {
      cls: 'jp-image-time-confirm-question',
      text: t('capture.metadataModalQuestion'),
    });

    const list = contentEl.createEl('ul', { cls: 'jp-image-metadata-confirm-list' });
    if (capturedAt !== null) {
      const capturedDate = moment(capturedAt);
      const label = capturedDate.isSame(moment(), 'day')
        ? t('capture.metadataModalTimeLabel', { time: formatTimeHHMM(capturedAt) })
        : t('capture.metadataModalTimeLabelOtherDay', { datetime: capturedDate.format('YYYY-MM-DD HH:mm') });
      list.createEl('li', { text: label });
    }
    if (this.location !== null) {
      this.locationLi = list.createEl('li', { cls: 'jp-image-metadata-confirm-location' });
      this.renderLocationLine();
    }

    const actions = contentEl.createDiv({ cls: 'jp-image-time-confirm-actions' });
    const useNowBtn = actions.createEl('button', {
      cls: 'jp-image-time-confirm-cancel',
      text: t('capture.metadataModalDecline'),
    });
    useNowBtn.addEventListener('click', () => this.decide(false));

    const useImageBtn = actions.createEl('button', {
      cls: 'mod-cta jp-image-time-confirm-confirm',
      text: t('capture.metadataModalAccept'),
    });
    useImageBtn.addEventListener('click', () => this.decide(true));

    window.setTimeout(() => useNowBtn.focus(), 0);
  }

  /** Re-renders the location `<li>` — text plus, on failure, a "重试" button. */
  private renderLocationLine(): void {
    const loc = this.location;
    if (!this.locationLi || !loc) return;
    this.locationLi.empty();

    const label = loc.name ?? (this.retrying
      ? t('capture.coordLocating')
      : t('capture.coordGeocodeFailed', { lat: loc.latitude.toFixed(4), lon: loc.longitude.toFixed(4) }));
    this.locationLi.createSpan({ text: t('capture.metadataModalLocationLabel', { label }) });

    // Only offer "重试" once a lookup has actually failed — while one is in
    // flight (the initial background geocode, or a manual retry), the label
    // above already says so; a second "获取中…" on the button was redundant.
    if (loc.name === null && !this.retrying) {
      const retryBtn = this.locationLi.createEl('button', {
        cls: 'jp-image-metadata-retry-btn',
        text: t('capture.retry'),
      });
      retryBtn.addEventListener('click', () => void this.retryLocationName());
    }
  }

  private async retryLocationName(): Promise<void> {
    if (this.retrying || !this.location) return;
    this.retrying = true;
    this.renderLocationLine();
    const name = await reverseGeocodeCity(this.location.latitude, this.location.longitude);
    this.retrying = false;
    if (this.location) this.location.name = name;
    this.renderLocationLine();
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide(false); // dismissed → keep the default "now" timestamp and no location
  }
}

// ── Delete confirmation modal ──────────────────────────────────────────────

interface DeleteConfirmOptions {
  title: string;
  /** Single-line preview of the entry body. */
  preview: string;
  /** HH:MM timestamp of the entry being deleted. */
  timestamp: string;
  /** Audio file paths that will be trashed (empty = text-only delete). */
  audioPaths: string[];
  /** Which delete mode the user picked — affects copy in the dialog body. */
  mode: DeleteMode;
  onConfirm: () => void;
}

/**
 * Small confirm dialog shown before any timeline entry is deleted. Two
 * affordances:
 *   - Body preview + audio file list (so the user sees what they're about
 *     to lose before clicking 删除)
 *   - Esc / 取消 / clicking outside all dismiss
 *
 * Audio files are trashed via `fileManager.trashFile` (Obsidian-respecting
 * recycle bin), not permanently removed — the modal copy reflects that.
 */
class DeleteConfirmModal extends Modal {
  private opts: DeleteConfirmOptions;

  constructor(app: import('obsidian').App, opts: DeleteConfirmOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.opts.title);
    titleEl.addClass('jp-modal-title-flush');

    contentEl.addClass('jp-delete-confirm');

    contentEl.createEl('p', {
      cls: 'jp-delete-confirm-question',
      text:
        this.opts.mode === 'audio-only'
          ? t('capture.deleteConfirmAudioOnlyQuestion')
          : t('capture.deleteConfirmQuestion'),
    });

    // Preview card — timestamp + body preview
    const preview = contentEl.createDiv({ cls: 'jp-delete-confirm-preview' });
    preview.createEl('span', {
      cls: 'jp-timestamp',
      text: this.opts.timestamp,
    });
    preview.createEl('span', {
      cls: 'jp-delete-confirm-preview-text',
      text: this.opts.preview.length > 0 ? this.opts.preview : t('capture.emptyMemoPlaceholder'),
    });

    // Audio file list (only when audio is being trashed)
    if (this.opts.audioPaths.length > 0) {
      const audioBlock = contentEl.createDiv({ cls: 'jp-delete-confirm-audio' });
      audioBlock.createEl('div', {
        cls: 'jp-delete-confirm-audio-label',
        text:
          this.opts.mode === 'audio-only'
            ? t('capture.deleteConfirmAudioListLabelOnly')
            : t('capture.deleteConfirmAudioListLabelWith'),
      });
      const list = audioBlock.createEl('ul', { cls: 'jp-delete-confirm-audio-list' });
      for (const path of this.opts.audioPaths) {
        list.createEl('li', { text: path });
      }
    }

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'jp-delete-confirm-actions' });
    const cancelBtn = actions.createEl('button', {
      cls: 'jp-delete-confirm-cancel',
      text: t('capture.cancel'),
    });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = actions.createEl('button', {
      cls: 'mod-warning jp-delete-confirm-confirm',
      text: t('capture.deleteAction'),
    });
    confirmBtn.addEventListener('click', () => {
      this.close();
      this.opts.onConfirm();
    });
    // Initial focus on cancel — safer default for a destructive dialog.
    window.setTimeout(() => cancelBtn.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── Tag management modals (rename / move / merge / delete) ──────────────

/** Small text-input prompt for renaming a tag's own segment name. */
class TagRenameModal extends Modal {
  private currentName: string;
  private onSubmit: (newName: string) => void;

  constructor(app: import('obsidian').App, currentName: string, onSubmit: (newName: string) => void) {
    super(app);
    this.currentName = currentName;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(t('tag.manage.renameTitle'));
    titleEl.addClass('jp-modal-title-flush');

    contentEl.addClass('jp-tag-rename-modal');

    const inputEl = contentEl.createEl('input', {
      type: 'text',
      cls: 'jp-tag-rename-input',
      value: this.currentName,
    });
    inputEl.select();

    const submit = () => {
      const value = inputEl.value;
      this.close();
      this.onSubmit(value);
    };

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });

    const actions = contentEl.createDiv({ cls: 'jp-delete-confirm-actions' });
    const cancelBtn = actions.createEl('button', {
      cls: 'jp-delete-confirm-cancel',
      text: t('capture.cancel'),
    });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = actions.createEl('button', {
      cls: 'mod-cta jp-delete-confirm-confirm',
      text: t('tag.manage.renameAction'),
    });
    confirmBtn.addEventListener('click', submit);

    window.setTimeout(() => inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Fuzzy-suggest modal for picking a "move under" parent or "merge into" target tag. */
class TagPickerModal extends FuzzySuggestModal<string> {
  private items: string[];

  constructor(app: import('obsidian').App, items: string[], mode: 'move' | 'merge', private onChoose: (item: string) => void) {
    super(app);
    this.items = items;
    this.setPlaceholder(mode === 'move' ? t('tag.manage.movePlaceholder') : t('tag.manage.mergePlaceholder'));
  }

  getItems(): string[] {
    return this.items;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onChoose(item);
  }
}

/** Confirms a tag delete, offering to also drop its child tags when the node has any. */
class TagDeleteConfirmModal extends Modal {
  private opts: {
    tag: string;
    hasChildren: boolean;
    ownCount: number;
    totalCount: number;
    onConfirm: (includeChildren: boolean) => void;
  };

  constructor(app: import('obsidian').App, opts: TagDeleteConfirmModal['opts']) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(t('tag.manage.deleteTitle'));
    titleEl.addClass('jp-modal-title-flush');

    contentEl.addClass('jp-delete-confirm');

    contentEl.createEl('p', {
      cls: 'jp-delete-confirm-question',
      text: t('tag.manage.deleteQuestion', { tag: this.opts.tag, count: String(this.opts.ownCount) }),
    });

    let includeChildren = false;
    if (this.opts.hasChildren) {
      const label = contentEl.createEl('label', { cls: 'jp-tag-delete-children-option' });
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.addEventListener('change', () => {
        includeChildren = checkbox.checked;
      });
      label.createSpan({ text: t('tag.manage.deleteIncludeChildren', { count: String(this.opts.totalCount - this.opts.ownCount) }) });
    }

    const actions = contentEl.createDiv({ cls: 'jp-delete-confirm-actions' });
    const cancelBtn = actions.createEl('button', {
      cls: 'jp-delete-confirm-cancel',
      text: t('capture.cancel'),
    });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = actions.createEl('button', {
      cls: 'mod-warning jp-delete-confirm-confirm',
      text: t('capture.deleteAction'),
    });
    confirmBtn.addEventListener('click', () => {
      this.close();
      this.opts.onConfirm(includeChildren);
    });
    window.setTimeout(() => cancelBtn.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── Calendar picker modal ────────────────────────────────────────────────

/**
 * Month-grid date picker for the capture timeline's day nav. Shows a dot
 * under any day that has journal content, highlights today, and disables
 * days in the future. Picking a day calls `onPick` and closes.
 */
class CalendarPickerModal extends Modal {
  private viewMonth: moment.Moment;

  constructor(
    app: import('obsidian').App,
    private selected: moment.Moment,
    private getMonthEntryDays: (monthStart: moment.Moment) => Promise<Set<string>>,
    private onPick: (date: moment.Moment) => void,
  ) {
    super(app);
    this.viewMonth = selected.clone().startOf('month');
  }

  onOpen(): void {
    this.modalEl.addClass('jp-calendar-modal');
    void this.renderMonth();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async renderMonth(): Promise<void> {
    const { contentEl } = this;
    const requestedMonth = this.viewMonth;
    contentEl.empty();

    const header = contentEl.createDiv({ cls: 'jp-cal-header' });
    const prevBtn = header.createEl('button', { cls: 'jp-cal-nav-btn', attr: { 'aria-label': t('capture.calPrevMonth') } });
    setIcon(prevBtn, 'chevron-left');
    prevBtn.addEventListener('click', () => {
      this.viewMonth = this.viewMonth.clone().subtract(1, 'month');
      void this.renderMonth();
    });

    header.createDiv({
      cls: 'jp-cal-title',
      text: this.viewMonth.format(currentLocale() === 'zh' ? 'YYYY年M月' : 'MMMM YYYY'),
    });

    const nextBtn = header.createEl('button', { cls: 'jp-cal-nav-btn', attr: { 'aria-label': t('capture.calNextMonth') } });
    setIcon(nextBtn, 'chevron-right');
    nextBtn.addEventListener('click', () => {
      this.viewMonth = this.viewMonth.clone().add(1, 'month');
      void this.renderMonth();
    });

    const weekRow = contentEl.createDiv({ cls: 'jp-cal-weekdays' });
    const weekdayShort = currentLocale() === 'zh'
      ? ['日', '一', '二', '三', '四', '五', '六']
      : ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    for (const w of weekdayShort) {
      weekRow.createDiv({ cls: 'jp-cal-weekday', text: w });
    }

    const grid = contentEl.createDiv({ cls: 'jp-cal-grid' });
    grid.createDiv({ cls: 'jp-cal-loading', text: t('capture.calLoading') });

    const entryDays = await this.getMonthEntryDays(this.viewMonth);
    // A newer render may have started (user flipped months again) — bail.
    if (this.viewMonth !== requestedMonth) return;
    grid.empty();

    const today = moment().startOf('day');
    const firstDow = this.viewMonth.clone().startOf('month').day();
    for (let i = 0; i < firstDow; i++) {
      grid.createDiv({ cls: 'jp-cal-cell is-empty' });
    }

    const daysInMonth = this.viewMonth.daysInMonth();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = this.viewMonth.clone().date(d);
      const isFuture = date.isAfter(today, 'day');
      const cell = grid.createDiv({ cls: 'jp-cal-cell' });
      if (date.isSame(today, 'day')) cell.addClass('is-today');
      if (date.isSame(this.selected, 'day')) cell.addClass('is-selected');
      if (isFuture) cell.addClass('is-future');

      if (entryDays.has(date.format('YYYY-MM-DD'))) cell.addClass('has-entries');
      cell.createSpan({ cls: 'jp-cal-cell-num', text: String(d) });

      if (!isFuture) {
        cell.addEventListener('click', () => {
          this.onPick(date);
          this.close();
        });
      }
    }

    if (!today.isSame(this.selected, 'day') || !today.isSame(this.viewMonth, 'month')) {
      const footer = contentEl.createDiv({ cls: 'jp-cal-footer' });
      const todayBtn = footer.createEl('button', { cls: 'jp-cal-today-btn', text: t('capture.backToToday') });
      todayBtn.addEventListener('click', () => {
        this.onPick(today);
        this.close();
      });
    }
  }
}

// ── Image preview modal ──────────────────────────────────────────────────

/** Full-size, chrome-free preview of a pending image thumbnail. */
class ImagePreviewModal extends Modal {
  constructor(app: import('obsidian').App, private src: string, private alt: string) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('jp-image-preview-modal');
    const img = this.contentEl.createEl('img', {
      cls: 'jp-image-preview-img',
      attr: { src: this.src, alt: this.alt },
    });
    img.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
