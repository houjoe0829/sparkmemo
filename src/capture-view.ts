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
  ItemView,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
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
  deleteEntryFromSection,
  extractAudioEmbeds,
  findSection,
  formatTimeHHMM,
  parseJournalEntries,
  removeAudioEmbedsFromEntry,
} from './section';
import { readExifCaptureDate } from './exif';
import { encodeWebp } from './webp-encoder';
import {
  YearStats,
  AllTimeStats,
  computeYearStats,
  computeAllTimeStats,
  formatChineseWordCount,
  getHeatmapLevel,
} from './stats';
import type SparkMemoPlugin from './main';

export const CAPTURE_VIEW_TYPE = 'spark-memo-capture-view';

/**
 * Which "delete" action the context menu picked. Surfacing this as a type
 * (instead of two booleans) keeps `executeDelete` and the confirm modal
 * exhaustive — adding a fourth mode in the future will fail to type-check
 * any switch that doesn't handle it.
 */
type DeleteMode = 'memo' | 'memo+audio' | 'audio-only';

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
  private currentTab: 'capture' | 'stats' | 'search' | 'review' = 'capture';
  private tabBarEl!: HTMLElement;
  private capturePaneEl!: HTMLElement;
  private statsPaneEl!: HTMLElement;
  private reviewPaneEl!: HTMLElement;
  private captureTabBtn!: HTMLButtonElement;
  private statsTabBtn!: HTMLButtonElement;
  private searchTabBtn!: HTMLButtonElement;
  private reviewTabBtn!: HTMLButtonElement;

  // Search state
  private searchBarEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private searchActive = false;
  private searchDebounceTimer: number | null = null;
  private searchQuery = '';
  private searchVersion = 0;
  /** All daily note files sorted newest→oldest, set at search start. */
  private searchFileQueue: TFile[] = [];
  /** Index into searchFileQueue: next file to scan in loadMoreSearchResults. */
  private searchCursor = 0;

  // DOM references (capture pane)
  private inputCardEl!: HTMLElement;
  private dayNavEl!: HTMLElement;
  private prevDayBtn!: HTMLButtonElement;
  private nextDayBtn!: HTMLButtonElement;
  private calendarBtn!: HTMLButtonElement;
  private timelineEl!: HTMLElement;
  private sentinelEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private submitBtn!: HTMLButtonElement;
  private attachmentListEl!: HTMLElement;
  private captureTimePillEl!: HTMLElement;
  /** Images picked but not yet appended to the note text; flushed on submit. */
  private pendingImages: TFile[] = [];
  /** Hard cap on pending images per entry — keeps the preview grid to a single row/2×2 square. */
  private static readonly MAX_PENDING_IMAGES = 9;
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

  // DOM references (stats pane)
  private statsToolbarEl!: HTMLElement;
  private statsBodyEl!: HTMLElement;
  private statsYearLabelEl!: HTMLElement;

  // Stats state
  private statsLoading = false;
  private statsRefreshTimer: number | null = null;
  /** All years' stats for all-time aggregation. */
  private allYearStats: Map<number, YearStats> = new Map();
  /** All-time aggregated stats. */
  private allTimeStats: AllTimeStats | null = null;

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
    return '快速记录';
  }

  getIcon(): string {
    return 'feather';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('jp-capture-root');

    // Top-level tab bar — switches between "快速记录" and "年度统计".
    this.buildTabBar(root as HTMLElement);

    // Capture pane (default visible)
    this.capturePaneEl = (root as HTMLElement).createDiv({ cls: 'jp-pane jp-pane-capture' });
    this.buildInputCard(this.capturePaneEl);
    this.buildTimeline(this.capturePaneEl);

    // Stats pane (hidden initially; built lazily on first switch)
    this.statsPaneEl = (root as HTMLElement).createDiv({ cls: 'jp-pane jp-pane-stats' });
    this.statsPaneEl.style.display = 'none';

    // Review pane (hidden initially)
    this.reviewPaneEl = (root as HTMLElement).createDiv({ cls: 'jp-pane jp-pane-review' });
    this.reviewPaneEl.style.display = 'none';

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
          this.scheduleStatsRefresh();
        }
      }),
    );
    // create: a new daily note (today, or an older one) — full rebuild
    this.registerEvent(
      this.app.vault.on('create', file => {
        if (file instanceof TFile && file.extension === 'md') {
          this.scheduleFullRebuild();
          this.scheduleStatsRefresh();
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
          this.scheduleStatsRefresh();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
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

    this.captureTabBtn = this.makeTabBtn('feather', true, '快速记录');
    this.captureTabBtn.addEventListener('click', () => this.switchTab('capture'));

    this.reviewTabBtn = this.makeTabBtn('calendar', false, '随机回顾');
    this.reviewTabBtn.addEventListener('click', () => this.switchTab('review'));

    this.searchTabBtn = this.makeTabBtn('search', false, '搜索日记');
    this.searchTabBtn.addEventListener('click', () => this.switchTab('search'));

    this.statsTabBtn = this.makeTabBtn('bar-chart-2', false, '年度统计');
    this.statsTabBtn.addEventListener('click', () => this.switchTab('stats'));

    // Search bar — collapsed by default, shown when search tab is active
    this.searchBarEl = root.createDiv({ cls: 'jp-search-bar' });
    this.searchBarEl.style.display = 'none';

    const searchIcon = this.searchBarEl.createSpan({ cls: 'jp-search-bar-icon' });
    setIcon(searchIcon, 'search');

    this.searchInputEl = this.searchBarEl.createEl('input', {
      cls: 'jp-search-input',
      attr: { placeholder: '搜索日记…', type: 'text' },
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

  private switchTab(tab: 'capture' | 'stats' | 'search' | 'review') {
    if (this.currentTab === tab) return;
    const prevTab = this.currentTab;
    this.currentTab = tab;

    this.captureTabBtn.toggleClass('is-active', tab === 'capture');
    this.reviewTabBtn.toggleClass('is-active', tab === 'review');
    this.searchTabBtn.toggleClass('is-active', tab === 'search');
    this.statsTabBtn.toggleClass('is-active', tab === 'stats');

    if (tab === 'search') {
      this.capturePaneEl.style.display = '';
      this.statsPaneEl.style.display = 'none';
      this.reviewPaneEl.style.display = 'none';
      this.inputCardEl.style.display = 'none';
      this.searchBarEl.style.display = '';
      this.searchActive = true;

      if (prevTab !== 'search') {
        if (this.searchQuery.length === 0) {
          this.disposeDays();
          this.timelineEl.empty();
          this.exhausted = false;
          this.searchFileQueue = [];
          this.searchCursor = 0;
          this.renderTopLevelMessage('输入关键词开始搜索');
        }
        this.searchInputEl.value = this.searchQuery;
        window.setTimeout(() => this.searchInputEl.focus(), 50);
      }
    } else if (tab === 'capture') {
      this.capturePaneEl.style.display = '';
      this.statsPaneEl.style.display = 'none';
      this.reviewPaneEl.style.display = 'none';
      this.inputCardEl.style.display = '';
      this.searchBarEl.style.display = 'none';

      // Always clean up search state when returning to capture
      if (this.searchActive || prevTab === 'search') {
        this.searchActive = false;
        if (this.searchDebounceTimer !== null) {
          window.clearTimeout(this.searchDebounceTimer);
          this.searchDebounceTimer = null;
        }
      }
      // Rebuild if coming from any non-capture tab, or if timeline looks stale
      // (e.g. capture → search → review → capture leaves search content in timelineEl)
      if (prevTab !== 'capture') {
        void this.fullRebuild();
      }
    } else if (tab === 'review') {
      this.capturePaneEl.style.display = 'none';
      this.statsPaneEl.style.display = 'none';
      this.reviewPaneEl.style.display = '';
      this.searchBarEl.style.display = 'none';
      void this.loadReview();
    } else {
      // stats tab
      this.capturePaneEl.style.display = 'none';
      this.statsPaneEl.style.display = '';
      this.reviewPaneEl.style.display = 'none';
      this.inputCardEl.style.display = '';
      this.searchBarEl.style.display = 'none';

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
      this.renderTopLevelMessage('输入关键词开始搜索');
      return;
    }

    if (!appHasDailyNotesPluginLoaded()) {
      this.renderTopLevelMessage('请先启用 Obsidian 自带的「Daily Notes」核心插件');
      return;
    }

    this.renderTopLevelMessage('搜索中…');

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

          // Remove "搜索中…" placeholder on first hit
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
          this.renderTopLevelMessage(`未找到包含「${query}」的记录`);
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
    headerText.createEl('div', { cls: 'jp-timeline-header-sub', text: `${entries.length} 条匹配` });
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

      const bubble = row.createDiv({ cls: 'jp-timeline-bubble jp-search-bubble' });
      // Render markdown first, then highlight keywords in the resulting DOM text nodes
      void MarkdownRenderer.render(this.app, entry.text, bubble, sourcePath, day.scope).then(() => {
        this.highlightKeyword(bubble, query);
        this.applyImageGrid(bubble);
        this.attachImagePreviews(bubble);
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


  private buildInputCard(root: HTMLElement) {
    this.inputCardEl = root.createDiv({ cls: 'jp-capture-card' });

    // Pending-image thumbnail strip — sits above the textarea, pushing it
    // down, so added images preview like an attachment card would.
    this.attachmentListEl = this.inputCardEl.createDiv({ cls: 'jp-capture-attachments jp-capture-attachments--empty' });

    // Wrapper for textarea
    const inputWrapper = this.inputCardEl.createDiv({ cls: 'jp-capture-input-wrapper' });

    this.textareaEl = inputWrapper.createEl('textarea', {
      cls: 'jp-capture-input',
      attr: {
        placeholder: "What's happening?",
        rows: '3',
      },
    });
    this.textareaEl.addEventListener('input', () => {
      this.refreshSubmitState();
      this.autoResizeTextarea();
    });
    // Configurable shortcut to submit (default Shift+Enter).
    this.textareaEl.addEventListener('keydown', evt => {
      if (evt.key !== 'Enter' || evt.isComposing) return;
      const shortcut = this.plugin.settings.submitShortcut;
      const matches =
        (shortcut.includes('shift') ? evt.shiftKey : !evt.shiftKey) &&
        (shortcut.includes('ctrl') ? evt.ctrlKey : !evt.ctrlKey) &&
        (shortcut.includes('alt') ? evt.altKey : !evt.altKey) &&
        (shortcut.includes('cmd') ? evt.metaKey : !evt.metaKey);
      if (matches) {
        evt.preventDefault();
        void this.handleSubmit();
      }
    });
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
    const recStatus = recMeta.createEl('span', { cls: 'jp-recording-status', text: '录音中…' });
    // Centered stop button shown beneath the waveform while recording.
    const recStopBtn = recBar.createEl('button', {
      cls: 'jp-recording-stop',
      attr: { 'aria-label': '停止' },
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
        new Notice('已添加图片，无法同时录音');
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
          recStatus.setText('转写中…');
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
                new Notice(`转写失败：${err instanceof Error ? err.message : String(err)}`);
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
            new Notice(`录音保存失败：${err instanceof Error ? err.message : String(err)}`);
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
          recStatus.setText(realtimeActive ? '实时转写中…' : '录音中…');
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
          new Notice('录音已自动停止（最长5分钟）');
        }, 5 * 60 * 1000);
      } catch (err) {
        new Notice(`无法访问麦克风：${err instanceof Error ? err.message : String(err)}`);
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
      attr: { 'aria-label': '添加' },
    });
    setIcon(plusBtn, 'plus');

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
      const imageDisabled = hasAudio || imageMaxedOut;
      const micDisabled = hasImages;

      const menu = new Menu();
      menu.addItem(item => item
        .setTitle(`上传图片（最多 ${JournalCaptureView.MAX_PENDING_IMAGES} 张）`)
        .setIcon('image')
        .setDisabled(imageDisabled)
        .onClick(() => {
          if (imageDisabled) return;
          fileInput.click();
        }));
      menu.addItem(item => item
        .setTitle('录音')
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

    // Capture-time override pill — shown to the right of the icon-button
    // pill once the user opts into using an image's capture time instead of
    // "now". Removable, since the user may change their mind before submit.
    this.captureTimePillEl = leftGroup.createDiv({ cls: 'jp-capture-time-pill jp-capture-time-pill--hidden' });

    this.submitBtn = actions.createEl('button', {
      cls: 'jp-capture-submit',
      attr: { 'aria-label': '记录' },
    });
    setIcon(this.submitBtn, 'arrow-up');
    this.submitBtn.addEventListener('click', () => {
      void this.handleSubmit();
    });

    this.refreshSubmitState();
    this.renderCaptureTimePill();
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
          attr: { 'aria-label': '移除图片' },
        });
        setIcon(removeBtn, 'x');
        removeBtn.addEventListener('click', () => {
          this.pendingImages = this.pendingImages.filter(f => f !== file);
          this.renderAttachmentList();
          this.refreshSubmitState();
          if (this.pendingImages.length === 0) {
            this.pendingCaptureOverride = null;
            this.renderCaptureTimePill();
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
        attr: { 'aria-label': '移除录音' },
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
      attr: { 'aria-label': '改回使用当前时间' },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('click', () => {
      this.pendingCaptureOverride = null;
      this.renderCaptureTimePill();
      new Notice('已改回使用当前时间记录');
    });
  }

  /**
   * Saves the picked/pasted/dropped image(s), adds them to the pending
   * strip (capped at `MAX_PENDING_IMAGES`), and — if enabled — checks the
   * *earliest* capture time across this batch against now.
   */
  private async addImageFiles(files: File[]): Promise<void> {
    if (this.pendingAudio.length > 0) {
      new Notice('已添加录音，无法同时添加图片');
      return;
    }
    const room = JournalCaptureView.MAX_PENDING_IMAGES - this.pendingImages.length;
    if (room <= 0) {
      new Notice(`最多添加 ${JournalCaptureView.MAX_PENDING_IMAGES} 张图片`);
      return;
    }
    const accepted = files.slice(0, room);
    if (files.length > accepted.length) {
      new Notice(`最多添加 ${JournalCaptureView.MAX_PENDING_IMAGES} 张图片，已忽略多余的 ${files.length - accepted.length} 张`);
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
        new Notice(
          `🗜️ 已压缩 ${compressedCount} 张图片：${formatBytes(originalTotal)} → ${formatBytes(compressedTotal)}（节省 ${savedPct}%）`,
        );
      }
      // Capture-time check reads the *original* files — compression can
      // strip EXIF, but the original still carries it in memory here.
      await this.maybeCheckImageTimes(accepted);
    } catch (err) {
      new Notice(`图片保存失败：${err instanceof Error ? err.message : String(err)}`);
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
   * If any image in this batch carries a capture time (EXIF for JPEGs,
   * otherwise the file's last-modified time) that differs from "now" by
   * more than 5 minutes, ask the user whether to anchor this entry to the
   * *earliest* of those capture times instead — including its calendar
   * date, so a photo from an earlier day lands in that day's daily note
   * rather than today's. Only asks once per pending-image batch — once an
   * override is set, later images are assumed to belong to the same moment.
   */
  private async maybeCheckImageTimes(files: File[]): Promise<void> {
    if (!this.plugin.settings.imageTimeCheck) return;
    if (this.pendingCaptureOverride) return;

    const capturedTimes = (await Promise.all(files.map(f => getImageCaptureTime(f))))
      .filter((d): d is Date => d !== null);
    if (capturedTimes.length === 0) return;

    const earliest = capturedTimes.reduce((a, b) => (a < b ? a : b));
    const diffMinutes = Math.abs(Date.now() - earliest.getTime()) / 60000;
    if (diffMinutes <= 5) return;

    const useImageTime = await confirmUseImageTime(this.app, earliest, diffMinutes);
    if (useImageTime) {
      const capturedDate = moment(earliest);
      this.pendingCaptureOverride = { date: capturedDate, time: formatTimeHHMM(earliest) };
      this.renderCaptureTimePill();
      new Notice(
        capturedDate.isSame(moment(), 'day')
          ? `✅ 已改用图片时间 ${this.pendingCaptureOverride.time} 记录`
          : `✅ 已改用图片时间记录，将写入 ${capturedDate.format('YYYY-MM-DD')} 的日记`,
      );
    }
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
      attr: { 'aria-label': '前一天' },
    });
    setIcon(this.prevDayBtn, 'chevron-left');
    this.prevDayBtn.addEventListener('click', () => this.navigateDay(-1));

    this.calendarBtn = this.dayNavEl.createEl('button', {
      cls: 'jp-day-nav-btn jp-day-nav-calendar-btn',
      attr: { 'aria-label': '选择日期' },
    });
    setIcon(this.calendarBtn, 'calendar');
    this.calendarBtn.addEventListener('click', () => this.openCalendarPicker());

    this.nextDayBtn = this.dayNavEl.createEl('button', {
      cls: 'jp-day-nav-btn',
      attr: { 'aria-label': '后一天' },
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
      this.renderTopLevelMessage('请先启用 Obsidian 自带的「Daily Notes」核心插件');
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

    const el = this.timelineEl.createDiv({
      cls: 'jp-timeline-bottom-nav' + (atLookbackFloor ? ' is-disabled' : ''),
    });
    if (atLookbackFloor) {
      el.setText('— 已到最早可查看的日期 —');
      return;
    }
    const icon = el.createSpan({ cls: 'jp-timeline-bottom-nav-icon' });
    setIcon(icon, 'chevron-down');
    el.createSpan({ text: '查看前一天' });
    el.addEventListener('click', () => this.navigateDay(-1));
  }

  /**
   * Probe `probeWindow` calendar days backwards looking for non-empty
   * journal sections, append any matches to the timeline. Updates
   * `nextProbeDate` and may flip `exhausted`.
   */
  private async loadMore(): Promise<void> {
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
        text: isToday ? '还没有 memo，写点什么吧 →' : '这一天没有 memo',
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

      // Body bubble: chat-style rounded card holding the rendered markdown.
      const bubble = row.createDiv({ cls: 'jp-timeline-bubble' });
      void MarkdownRenderer.render(this.app, entry.text, bubble, sourcePath, day.scope)
        .then(() => {
          this.applyImageGrid(bubble);
          this.attachImagePreviews(bubble);
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

  /** Build a human-readable date label. */
  private formatDateHeader(d: moment.Moment, count: number): { title: string; subtitle: string } {
    const weekdayZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.day()];
    const isCurrentYear = d.year() === moment().year();
    const dateLabel = d.format(isCurrentYear ? 'M/D' : 'YYYY/M/D') + ` · ${weekdayZh}`;
    const today = moment().startOf('day');
    const diff = d.diff(today, 'days');
    let relative = '';
    if (diff === 0) relative = ' · 今天';
    else if (diff === -1) relative = ' · 昨天';
    const title = dateLabel + relative;
    const subtitle = count === 0 ? '还没有 memo' : `${count} 个 memo`;
    return { title, subtitle };
  }

  private renderTopLevelMessage(msg: string) {
    this.timelineEl.createDiv({ cls: 'jp-capture-empty', text: msg });
  }

  private markEndOfTimeline() {
    // Replace sentinel functionality with a static end marker
    const end = createDiv({ cls: 'jp-timeline-end', text: '— 已加载到最早的日记 —' });
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

  // ── Review pane ─────────────────────────────────────────────────────────

  /** Load a random past daily note and render its entries as a timeline. */
  private async loadReview(): Promise<void> {
    this.reviewPaneEl.empty();

    if (!appHasDailyNotesPluginLoaded()) {
      this.reviewPaneEl.createDiv({ cls: 'jp-capture-empty', text: '请先启用 Obsidian 自带的「Daily Notes」核心插件' });
      return;
    }

    const allNotes = getAllDailyNotes() as Record<string, TFile>;
    const today = moment().startOf('day');
    const files = Object.values(allNotes).filter((f): f is TFile => {
      if (!(f instanceof TFile)) return false;
      const d = getDateFromFile(f, 'day');
      return !!d && d.isBefore(today, 'day');
    });

    if (files.length === 0) {
      this.reviewPaneEl.createDiv({ cls: 'jp-capture-empty', text: '还没有过去的日记可以回顾' });
      return;
    }

    // Pick a random file
    const file = files[Math.floor(Math.random() * files.length)];
    const date = getDateFromFile(file, 'day')!.clone().startOf('day');

    // Header with date + re-roll button
    const header = this.reviewPaneEl.createDiv({ cls: 'jp-review-header' });
    const dateEl = header.createDiv({ cls: 'jp-review-date' });
    const weekdayZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.day()];
    dateEl.setText(date.format('YYYY年M月D日') + ' · ' + weekdayZh);

    const rerollBtn = header.createEl('button', {
      cls: 'jp-review-reroll-btn',
      attr: { 'aria-label': '换一天' },
    });
    setIcon(rerollBtn, 'dice');
    rerollBtn.addEventListener('click', () => void this.loadReview());

    const openBtn = header.createEl('button', {
      cls: 'jp-review-reroll-btn',
      attr: { 'aria-label': '打开日记' },
    });
    setIcon(openBtn, 'crosshair');
    openBtn.addEventListener('click', () => void this.openDailyNoteByDate(date));

    // Parse entries
    let entries: Array<{ timestamp: string; text: string; lineIndex: number }> = [];
    try {
      const content = await this.app.vault.cachedRead(file);
      const section = findSection(content, this.plugin.settings.targetHeading, this.plugin.settings.headingLevel);
      if (section) {
        const text = content.slice(section.from, section.to);
        // First try normal timestamped entries
        const parsed = parseJournalEntries(text, this.plugin.settings.timestampPattern);
        if (parsed.length > 0) {
          entries = parsed;
        } else {
          // Fallback: treat every non-empty list item as an entry with 00:00
          entries = this.parseLooseEntries(text);
        }
      }
    } catch (err) {
      console.error('[Spark Memo] review read failed', err);
    }

    if (entries.length === 0) {
      this.reviewPaneEl.createDiv({ cls: 'jp-capture-empty', text: '这天没有日记内容' });
      return;
    }

    // Sort descending by timestamp
    const sorted = [...entries].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b.lineIndex - a.lineIndex,
    );

    const scope = new Component();
    scope.load();
    this.register(() => scope.unload());

    const timeline = this.reviewPaneEl.createDiv({ cls: 'jp-timeline' });
    const sourcePath = file.path;

    for (const entry of sorted) {
      const row = timeline.createDiv({ cls: 'jp-timeline-entry' });
      row.createDiv({ cls: 'jp-timeline-dot' });
      const head = row.createDiv({ cls: 'jp-timeline-entry-head' });
      head.createEl('span', { cls: 'jp-timestamp', text: entry.timestamp });
      const bubble = row.createDiv({ cls: 'jp-timeline-bubble' });
      void MarkdownRenderer.render(this.app, entry.text, bubble, sourcePath, scope)
        .then(() => {
          this.applyImageGrid(bubble);
          this.attachImagePreviews(bubble);
        });
    }
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
      text: '全量数据',
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

  /** Load + render stats for all available years. */
  private async loadAllStats(): Promise<void> {
    if (this.statsLoading) return;
    this.statsLoading = true;

    this.statsYearLabelEl.setText('全量数据');
    this.renderStatsLoading();

    try {
      if (!appHasDailyNotesPluginLoaded()) {
        this.renderStatsError('请先启用 Obsidian 自带的「Daily Notes」核心插件');
        return;
      }

      const all = getAllDailyNotes() as Record<string, TFile>;
      const yearMap = new Map<number, Array<{ key: string; sectionText: string }>>();

      // Group all daily notes by year
      for (const file of Object.values(all)) {
        if (!(file instanceof TFile)) continue;
        const d = getDateFromFile(file as TFile, 'day');
        if (!d) continue;
        const year = d.year();
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
      }

      // Compute stats for each year
      this.allYearStats.clear();
      for (const [year, dayInputs] of yearMap) {
        const ys = computeYearStats(year, dayInputs, this.plugin.settings.timestampPattern);
        this.allYearStats.set(year, ys);
      }

      // Compute all-time stats
      this.allTimeStats = computeAllTimeStats([...this.allYearStats.values()]);

      this.renderStatsContent();
    } catch (err) {
      console.error('[Spark Memo] stats load failed', err);
      this.renderStatsError(`加载失败：${err instanceof Error ? err.message : String(err)}`);
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
      text: '正在加载日记数据…',
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
    const formatted = formatChineseWordCount(allTime.totalWords);
    if (formatted.includes('万')) {
      const [num, unit] = formatted.split(' ');
      numLine.createSpan({ cls: 'jp-stats-hero-num', text: num });
      numLine.createSpan({ cls: 'jp-stats-hero-unit', text: unit });
    } else {
      numLine.createSpan({ cls: 'jp-stats-hero-num', text: formatted });
      numLine.createSpan({ cls: 'jp-stats-hero-unit', text: '字' });
    }

    const sub = top.createDiv({ cls: 'jp-stats-hero-sub' });
    const yearsStr = allTime.yearsWithData.length > 0
      ? `${allTime.yearsWithData[0]}–${allTime.yearsWithData[allTime.yearsWithData.length - 1]} 年`
      : '暂无数据';
    sub.createSpan({ text: yearsStr });

    const grid = hero.createDiv({ cls: 'jp-stats-hero-kpis' });
    this.makeStatsKPI(grid, 'file-text', `${allTime.writingDays}`, '天', '写作天数');
    this.makeStatsKPI(grid, 'pencil', `${allTime.totalEntries}`, '条', '总条数');
    this.makeStatsKPI(grid, 'mic', `${allTime.totalAudios}`, '段', '录音数');
    this.makeStatsKPI(grid, 'flame', `${allTime.longestStreak}`, '天', '最长连续');

    // ── Per-year heatmaps ─────────────────────────────────────────────────
    const years = [...this.allYearStats.keys()].sort((a, b) => b - a);
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
    header.createDiv({ cls: 'jp-stats-heatmap-title', text: `${year} 年` });

    this.renderStatsHeatmap(
      section.createDiv({ cls: 'jp-stats-heatmap-wrap' }),
      stats,
    );

    // Legend
    const legend = section.createDiv({ cls: 'jp-stats-legend' });
    legend.createSpan({ cls: 'jp-stats-legend-label', text: '少' });
    for (let l = 0; l <= 4; l++) {
      legend.createDiv({ cls: `jp-stats-cell level-${l}` });
    }
    legend.createSpan({ cls: 'jp-stats-legend-label', text: '多' });

    // Footer summary
    const footer = section.createDiv({ cls: 'jp-stats-footer' });
    footer.setText(
      `${stats.writingDays} 天 · ${stats.totalWords.toLocaleString('en-US')} 字 · ${stats.totalEntries} 条` +
        (stats.totalAudios > 0 ? ` · ${stats.totalAudios} 段录音` : ''),
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
    const dayLabels: Record<number, string> = { 0: '一', 2: '三', 4: '五' };
    for (let i = 0; i < 7; i++) {
      labelsCol.createDiv({ cls: 'jp-stats-daylabel', text: dayLabels[i] ?? '' });
    }

    const rightCol = inner.createDiv({ cls: 'jp-stats-heatmap-right' });

    // Month-label row
    const monthRow = rightCol.createDiv({ cls: 'jp-stats-monthrow' });
    for (let w = 0; w < totalWeeks; w++) {
      const entry = Object.entries(monthWeek).find(([, wk]) => wk === w);
      monthRow.createDiv({
        cls: 'jp-stats-monthlabel',
        text: entry ? `${Number(entry[0]) + 1}月` : '',
      });
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

        const label = date.format('YYYY年M月D日');
        if (entryCount > 0) {
          cell.setAttr('title', `${label} · ${entryCount} 条 · ${wordCount} 字`);
        } else {
          cell.setAttr('title', isFuture ? label : `${label} · 未写`);
        }

        if (!isFuture) {
          cell.addEventListener('click', () => void this.openDailyNoteByDate(date));
        }
      }
    }
  }

  /** Add a locate button to the right side of a day header card. */
  private addOpenNoteBtn(headerCard: HTMLElement, day: DaySection) {
    if (!day.filePath) return;
    const btn = headerCard.createEl('button', {
      cls: 'jp-timeline-open-btn',
      attr: { 'aria-label': '打开日记' },
    });
    setIcon(btn, 'crosshair');
    btn.addEventListener('click', () => void this.openDailyNoteByDate(day.date));
  }

  /** Open the daily note for `date` in a new center tab. */
  private async openDailyNoteByDate(date: moment.Moment): Promise<void> {
    try {
      const file = getDailyNote(date, getAllDailyNotes()) as TFile | null;
      if (!file) {
        new Notice(`${date.format('YYYY年M月D日')} 没有日记文件`);
        return;
      }
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    } catch (err) {
      console.error('[Spark Memo] open daily note failed', err);
      new Notice('打开失败');
    }
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

  // ── Entry context menu (copy / delete) ──────────────────────────────────

  /**
   * Build and show the right-click / long-press context menu for one entry.
   * Items shown:
   *   - 复制                — copies the raw markdown body to clipboard
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
        .setTitle('复制')
        .setIcon('copy')
        .onClick(() => {
          void this.copyEntry(entry);
        }),
    );

    menu.addSeparator();

    menu.addItem(item =>
      item
        .setTitle('删除 memo')
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
              ? '仅删除录音文件（保留文字）'
              : `仅删除 ${audioPaths.length} 个录音文件（保留文字）`,
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
      new Notice('📋 已复制');
    } catch (err) {
      console.error('[Spark Memo] copy failed', err);
      new Notice(`复制失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Show a confirmation modal (when `settings.confirmDelete` is on) listing
   * what will be deleted, then execute the deletion on confirm. When the
   * setting is off, the action executes immediately.
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
          ? '删除 memo'
          : mode === 'memo+audio'
            ? '删除 memo 和录音文件'
            : '删除录音文件',
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
      new Notice('找不到对应的日记文件');
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(day.filePath);
    if (!(file instanceof TFile)) {
      new Notice('找不到对应的日记文件');
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
        new Notice('日记内容已变化，请刷新后重试');
        await this.refreshDay(day);
        return;
      }
      await this.app.vault.modify(file, next);
    } catch (err) {
      console.error('[Spark Memo] delete entry failed', err);
      new Notice(`删除失败：${err instanceof Error ? err.message : String(err)}`);
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
      new Notice('🗑️ 已删除');
    } else if (mode === 'memo+audio') {
      if (missing === audioPaths.length) {
        new Notice('🗑️ memo 已删除（录音文件已不存在）');
      } else if (trashed === audioPaths.length) {
        new Notice(`🗑️ 已删除 memo 和 ${trashed} 个录音文件`);
      } else {
        new Notice(`🗑️ memo 已删除；${trashed}/${audioPaths.length} 个录音文件移入回收站`);
      }
    } else {
      // audio-only
      if (missing === audioPaths.length) {
        new Notice('🎙️ 录音链接已移除（文件已不存在）');
      } else if (trashed === audioPaths.length) {
        new Notice(`🎙️ 已删除 ${trashed} 个录音文件（memo 保留）`);
      } else {
        new Notice(`🎙️ 链接已移除；${trashed}/${audioPaths.length} 个录音文件移入回收站`);
      }
    }
  }

  // ── Submit / write path ─────────────────────────────────────────────────

  private async handleSubmit(): Promise<void> {
    const text = this.textareaEl.value;
    if (text.trim().length === 0 && this.pendingImages.length === 0 && this.pendingAudio.length === 0) return;

    const embeds = [
      ...this.pendingImages.map(file => `![[${file.path}]]`),
      ...this.pendingAudio.map(a => `![[${a.file.path}]]`),
    ].join(' ');
    const raw = embeds
      ? (text.trim().length > 0 ? `${text}\n${embeds}` : embeds)
      : text;

    if (!appHasDailyNotesPluginLoaded()) {
      new Notice('请先启用 Obsidian 自带的「Daily Notes」核心插件');
      return;
    }

    this.submitBtn.disabled = true;
    this.submitBtn.addClass('jp-capture-submit--disabled');
    this.submitBtn.addClass('jp-capture-submit--loading');
    setIcon(this.submitBtn, 'loader-2');

    try {
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
      this.pendingImages = [];
      this.pendingAudio = [];
      this.pendingCaptureOverride = null;
      this.renderAttachmentList();
      this.renderCaptureTimePill();
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
        new Notice(`📅 已记录到 ${writtenDay.format('YYYY-MM-DD')} 的日记`);
      }
    } catch (err) {
      console.error('[Spark Memo] submit failed', err);
      new Notice(`写入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.submitBtn.removeClass('jp-capture-submit--loading');
      setIcon(this.submitBtn, 'arrow-up');
      this.refreshSubmitState();
    }
  }
}

/** Human-readable file size, e.g. 512 → "512 B", 2_400_000 → "2.4 MB". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
 * Asks whether to anchor the entry's timestamp to a photo's capture time
 * instead of "now". Resolves `true` only on an explicit "使用图片时间"
 * click — dismissing (Esc / click-outside / "使用当前时间") resolves `false`
 * and leaves the default "now" timestamp untouched.
 */
function confirmUseImageTime(
  app: import('obsidian').App,
  capturedAt: Date,
  diffMinutes: number,
): Promise<boolean> {
  return new Promise(resolve => {
    new ImageTimeConfirmModal(app, { capturedAt, diffMinutes }, resolve).open();
  });
}

interface ImageTimeConfirmOptions {
  capturedAt: Date;
  diffMinutes: number;
}

class ImageTimeConfirmModal extends Modal {
  private opts: ImageTimeConfirmOptions;
  private resolve: (useImageTime: boolean) => void;
  private decided = false;

  constructor(
    app: import('obsidian').App,
    opts: ImageTimeConfirmOptions,
    resolve: (useImageTime: boolean) => void,
  ) {
    super(app);
    this.opts = opts;
    this.resolve = resolve;
  }

  private decide(useImageTime: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(useImageTime);
    this.close();
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('图片时间与当前时间不符');
    titleEl.addClass('jp-modal-title-flush');
    contentEl.addClass('jp-image-time-confirm');

    contentEl.createEl('p', {
      cls: 'jp-image-time-confirm-question',
      text: '是否使用图片拍摄时间记录这条 memo？',
    });

    const actions = contentEl.createDiv({ cls: 'jp-image-time-confirm-actions' });
    const useNowBtn = actions.createEl('button', {
      cls: 'jp-image-time-confirm-cancel',
      text: '使用当前时间',
    });
    useNowBtn.addEventListener('click', () => this.decide(false));

    const useImageBtn = actions.createEl('button', {
      cls: 'mod-cta jp-image-time-confirm-confirm',
      text: '使用图片时间',
    });
    useImageBtn.addEventListener('click', () => this.decide(true));

    window.setTimeout(() => useNowBtn.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide(false); // dismissed → keep the default "now" timestamp
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
          ? '确定要删除这条 memo 的录音文件吗？memo 文字会保留。'
          : '确定要删除这条 memo 吗？',
    });

    // Preview card — timestamp + body preview
    const preview = contentEl.createDiv({ cls: 'jp-delete-confirm-preview' });
    preview.createEl('span', {
      cls: 'jp-timestamp',
      text: this.opts.timestamp,
    });
    preview.createEl('span', {
      cls: 'jp-delete-confirm-preview-text',
      text: this.opts.preview.length > 0 ? this.opts.preview : '(空 memo)',
    });

    // Audio file list (only when audio is being trashed)
    if (this.opts.audioPaths.length > 0) {
      const audioBlock = contentEl.createDiv({ cls: 'jp-delete-confirm-audio' });
      audioBlock.createEl('div', {
        cls: 'jp-delete-confirm-audio-label',
        text:
          this.opts.mode === 'audio-only'
            ? '将移入回收站的录音文件（可恢复）：'
            : '附带删除的录音文件（移入回收站，可恢复）：',
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
      text: '取消',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = actions.createEl('button', {
      cls: 'mod-warning jp-delete-confirm-confirm',
      text: '删除',
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
    const prevBtn = header.createEl('button', { cls: 'jp-cal-nav-btn', attr: { 'aria-label': '上个月' } });
    setIcon(prevBtn, 'chevron-left');
    prevBtn.addEventListener('click', () => {
      this.viewMonth = this.viewMonth.clone().subtract(1, 'month');
      void this.renderMonth();
    });

    header.createDiv({ cls: 'jp-cal-title', text: this.viewMonth.format('YYYY年M月') });

    const nextBtn = header.createEl('button', { cls: 'jp-cal-nav-btn', attr: { 'aria-label': '下个月' } });
    setIcon(nextBtn, 'chevron-right');
    nextBtn.addEventListener('click', () => {
      this.viewMonth = this.viewMonth.clone().add(1, 'month');
      void this.renderMonth();
    });

    const weekRow = contentEl.createDiv({ cls: 'jp-cal-weekdays' });
    for (const w of ['日', '一', '二', '三', '四', '五', '六']) {
      weekRow.createDiv({ cls: 'jp-cal-weekday', text: w });
    }

    const grid = contentEl.createDiv({ cls: 'jp-cal-grid' });
    grid.createDiv({ cls: 'jp-cal-loading', text: '加载中…' });

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
