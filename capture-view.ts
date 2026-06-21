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
  setIcon,
} from 'obsidian';
import {
  appHasDailyNotesPluginLoaded,
  getAllDailyNotes,
  getDailyNote,
} from 'obsidian-daily-notes-interface';

import {
  JournalEntry,
  deleteEntryFromSection,
  extractAudioEmbeds,
  findSection,
  parseJournalEntries,
} from './section';
import type JournalPartnerPlugin from './main';

export const CAPTURE_VIEW_TYPE = 'journal-partner-capture-view';

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
  private plugin: JournalPartnerPlugin;

  // DOM references
  private toolbarEl!: HTMLElement;
  private inputCardEl!: HTMLElement;
  private timelineEl!: HTMLElement;
  private sentinelEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private submitBtn!: HTMLButtonElement;
  private sortBtn!: HTMLButtonElement;

  // Cached state
  private days: DaySection[] = [];
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

  // ── Mobile toolbar auto-hide (scroll-direction triggered) ──
  /** Last observed scrollTop, for direction detection. */
  private lastScrollTop = 0;
  /** Bound scroll handler we install on the view's scroll container. */
  private onScrollBound: (() => void) | null = null;
  /** Element we attached the scroll listener to, kept for clean removal. */
  private scrollEl: HTMLElement | null = null;
  /** Min pixel delta between events that counts as a real scroll move. */
  private readonly scrollDeltaThreshold = 6;

  constructor(leaf: WorkspaceLeaf, plugin: JournalPartnerPlugin) {
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

    this.buildToolbar(root as HTMLElement);
    this.buildInputCard(root as HTMLElement);
    this.buildTimeline(root as HTMLElement);

    // ── Vault listeners ──
    // modify: refresh the affected day's section in place (no full rebuild)
    this.registerEvent(
      this.app.vault.on('modify', file => {
        if (!(file instanceof TFile)) return;
        const day = this.days.find(d => d.filePath === file.path);
        if (day) {
          this.scheduleDayRefresh(day);
        }
      }),
    );
    // create: a new daily note (today, or an older one) — full rebuild
    this.registerEvent(
      this.app.vault.on('create', file => {
        if (file instanceof TFile && file.extension === 'md') {
          this.scheduleFullRebuild();
        }
      }),
    );
    // delete: drop the day if it was loaded, then rebuild
    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (file instanceof TFile && this.days.some(d => d.filePath === file.path)) {
          this.scheduleFullRebuild();
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
    if (this.intersectionObs) {
      this.intersectionObs.disconnect();
      this.intersectionObs = null;
    }
    this.teardownMobileToolbarAutoHide();
    this.disposeDays();
    this.containerEl.children[1].empty();
  }

  // ── DOM construction ────────────────────────────────────────────────────

  private buildToolbar(root: HTMLElement) {
    this.toolbarEl = root.createDiv({ cls: 'jp-capture-toolbar' });

    const refreshBtn = this.toolbarEl.createEl('button', {
      cls: 'jp-capture-toolbar-btn',
      attr: { 'aria-label': '刷新', title: '刷新' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => {
      void this.fullRebuild();
    });

    this.sortBtn = this.toolbarEl.createEl('button', {
      cls: 'jp-capture-toolbar-btn',
      attr: { 'aria-label': '切换排序', title: '切换排序方向' },
    });
    this.updateSortIcon();
    this.sortBtn.addEventListener('click', async () => {
      this.plugin.settings.captureSortDesc = !this.plugin.settings.captureSortDesc;
      await this.plugin.saveSettings();
      this.updateSortIcon();
      // Sorting only affects within-day ordering; cheap to rebuild
      await this.fullRebuild();
    });
  }

  private updateSortIcon() {
    setIcon(
      this.sortBtn,
      this.plugin.settings.captureSortDesc ? 'arrow-down-narrow-wide' : 'arrow-up-narrow-wide',
    );
    this.sortBtn.setAttr(
      'title',
      this.plugin.settings.captureSortDesc ? '当前：最新在上' : '当前：最早在上',
    );
  }

  private buildInputCard(root: HTMLElement) {
    this.inputCardEl = root.createDiv({ cls: 'jp-capture-card' });

    this.textareaEl = this.inputCardEl.createEl('textarea', {
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
    // Shift+Enter submits (Enter alone keeps default newline behaviour for
    // multi-line composition, matching the user's chosen shortcut).
    this.textareaEl.addEventListener('keydown', evt => {
      if (evt.key === 'Enter' && evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        void this.handleSubmit();
      }
    });

    const actions = this.inputCardEl.createDiv({ cls: 'jp-capture-actions' });

    this.submitBtn = actions.createEl('button', {
      cls: 'jp-capture-submit',
      text: 'NOTE',
    });
    this.submitBtn.addEventListener('click', () => {
      void this.handleSubmit();
    });

    this.refreshSubmitState();
  }

  private buildTimeline(root: HTMLElement) {
    this.timelineEl = root.createDiv({ cls: 'jp-timeline' });
    this.sentinelEl = root.createDiv({ cls: 'jp-timeline-sentinel' });
  }

  // ── Behaviour ───────────────────────────────────────────────────────────

  private refreshSubmitState() {
    const hasContent = this.textareaEl.value.trim().length > 0;
    this.submitBtn.toggleClass('jp-capture-submit--disabled', !hasContent);
    this.submitBtn.disabled = !hasContent;
  }

  private autoResizeTextarea() {
    this.textareaEl.style.height = 'auto';
    const next = Math.min(this.textareaEl.scrollHeight, 240);
    this.textareaEl.style.height = `${next}px`;
  }

  private scheduleFullRebuild() {
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
      return;
    }

    // Reset scroll-window state
    this.nextProbeDate = moment().startOf('day').subtract(1, 'day');
    this.exhausted = false;
    this.loadingMore = false;

    // Always render today first (non-empty or not — gives users a stable
    // anchor and shows the "no entries yet" hint).
    const today = moment().startOf('day');
    const todayDay = await this.buildDaySection(today, /* allowEmpty */ true);
    if (todayDay) {
      this.timelineEl.appendChild(todayDay.el);
      this.days.push(todayDay);
    }

    // Then load the first batch of historical non-empty days.
    await this.loadMore();
  }

  /**
   * Probe `probeWindow` calendar days backwards looking for non-empty
   * journal sections, append any matches to the timeline. Updates
   * `nextProbeDate` and may flip `exhausted`.
   */
  private async loadMore(): Promise<void> {
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
      console.error('[Journal Partner] daily note resolve failed', err);
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
        console.error('[Journal Partner] read failed', err);
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
      console.error('[Journal Partner] day refresh failed', err);
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
    headerCard.createEl('div', { cls: 'jp-timeline-header-title', text: headerLabel.title });
    headerCard.createEl('div', { cls: 'jp-timeline-header-sub', text: headerLabel.subtitle });

    if (entries.length === 0) {
      // Today with no entries — soft hint only
      day.el.createDiv({ cls: 'jp-capture-empty', text: '还没有 memo，写点什么吧 →' });
      return;
    }

    // Sort entries within the day
    const latestTs = entries.reduce<string>(
      (acc, e) => (e.timestamp > acc ? e.timestamp : acc),
      '',
    );
    const sorted = [...entries].sort((a, b) => {
      if (a.timestamp === b.timestamp) {
        return this.plugin.settings.captureSortDesc
          ? b.lineIndex - a.lineIndex
          : a.lineIndex - b.lineIndex;
      }
      return this.plugin.settings.captureSortDesc
        ? a.timestamp < b.timestamp ? 1 : -1
        : a.timestamp < b.timestamp ? -1 : 1;
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
      void MarkdownRenderer.render(this.app, entry.text, bubble, sourcePath, day.scope);

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
    const dateLabel = d.format('YYYY年M月D日') + ` · ${weekdayZh}`;
    const today = moment().startOf('day');
    const diff = d.diff(today, 'days');
    let relative = '';
    if (diff === 0) relative = ' · 今天';
    else if (diff === -1) relative = ' · 昨天';
    else if (diff === 1) relative = ' · 明天';
    else if (diff < 0) relative = ` · ${-diff} 天前`;
    else relative = ` · ${diff} 天后`;
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
   *   - 复制         — copies the raw markdown body to clipboard
   *   - 删除 memo    — deletes only the entry line(s) from the daily note
   *   - 删除 memo 和录音文件 — same, plus trashes embedded audio attachments
   *
   * The "with audio" item is only added when the entry actually embeds at
   * least one audio attachment (`![[*.m4a]]` etc.).
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
          this.confirmAndDelete(day, entry, /* withAudio */ false, audioPaths);
        }),
    );

    if (audioPaths.length > 0) {
      menu.addItem(item =>
        item
          .setTitle(
            audioPaths.length === 1
              ? '删除 memo 和录音文件'
              : `删除 memo 和 ${audioPaths.length} 个录音文件`,
          )
          .setIcon('trash-2')
          .onClick(() => {
            this.confirmAndDelete(day, entry, /* withAudio */ true, audioPaths);
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
      console.error('[Journal Partner] copy failed', err);
      new Notice(`复制失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Show a confirmation modal listing what will be deleted, then execute the
   * deletion on confirm. Audio files (when requested) are moved to Obsidian's
   * configured trash via `fileManager.trashFile` so they remain recoverable.
   */
  private confirmAndDelete(
    day: DaySection,
    entry: JournalEntry,
    withAudio: boolean,
    audioPaths: string[],
  ) {
    const preview = this.buildEntryPreview(entry);
    new DeleteConfirmModal(this.app, {
      title: withAudio ? '删除 memo 和录音文件' : '删除 memo',
      preview,
      timestamp: entry.timestamp,
      audioPaths: withAudio ? audioPaths : [],
      onConfirm: () => {
        void this.executeDelete(day, entry, withAudio ? audioPaths : []);
      },
    }).open();
  }

  /** Compact preview text for the confirm modal (≤ 80 chars, single line). */
  private buildEntryPreview(entry: JournalEntry): string {
    const raw = entry.text.replace(/\s+/g, ' ').trim();
    return raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
  }

  /**
   * Perform the actual deletion. Rewrites the daily note via
   * `vault.modify`, then trashes any audio files. Audio failures are
   * logged but don't roll back the text deletion — they're independent
   * pieces of state and the user explicitly opted into both.
   */
  private async executeDelete(
    day: DaySection,
    entry: JournalEntry,
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
      const next = deleteEntryFromSection(
        content,
        this.plugin.settings,
        entry.lineIndex,
      );
      if (next === content) {
        // No-op means our lineIndex no longer matches a head line — the file
        // changed under us. Refresh and bail rather than mangling content.
        new Notice('日记内容已变化，请刷新后重试');
        await this.refreshDay(day);
        return;
      }
      await this.app.vault.modify(file, next);
    } catch (err) {
      console.error('[Journal Partner] delete entry failed', err);
      new Notice(`删除失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Trash embedded audio files (best-effort, independent of text deletion)
    let trashed = 0;
    let missing = 0;
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
        console.error(`[Journal Partner] trash audio failed: ${path}`, err);
      }
    }

    if (audioPaths.length === 0) {
      new Notice('🗑️ 已删除');
    } else if (missing === audioPaths.length) {
      new Notice('🗑️ memo 已删除（录音文件已不存在）');
    } else if (trashed === audioPaths.length) {
      new Notice(`🗑️ 已删除 memo 和 ${trashed} 个录音文件`);
    } else {
      new Notice(`🗑️ memo 已删除；${trashed}/${audioPaths.length} 个录音文件移入回收站`);
    }
  }

  // ── Submit / write path ─────────────────────────────────────────────────

  private async handleSubmit(): Promise<void> {
    const raw = this.textareaEl.value;
    if (raw.trim().length === 0) return;

    if (!appHasDailyNotesPluginLoaded()) {
      new Notice('请先启用 Obsidian 自带的「Daily Notes」核心插件');
      return;
    }

    this.submitBtn.disabled = true;
    this.submitBtn.addClass('jp-capture-submit--disabled');
    const originalText = this.submitBtn.textContent;
    this.submitBtn.setText('写入中…');

    try {
      const ok = await this.plugin.writeToTodayJournal(raw);
      if (!ok) return;

      this.textareaEl.value = '';
      this.autoResizeTextarea();

      // vault.modify will catch-up the today section automatically; if
      // today's section wasn't mounted (e.g. plugin just opened with no
      // file), trigger a full rebuild so it appears at the top.
      const todayDay = this.days.find(d =>
        d.date.isSame(moment().startOf('day'), 'day'),
      );
      if (!todayDay) {
        await this.fullRebuild();
      }

      // Scroll to top so user sees the new entry land
      const scroller = this.containerEl.children[1] as HTMLElement;
      scroller.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      console.error('[Journal Partner] submit failed', err);
      new Notice(`写入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.submitBtn.setText(originalText ?? 'NOTE');
      this.refreshSubmitState();
    }
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

    contentEl.addClass('jp-delete-confirm');

    contentEl.createEl('p', {
      cls: 'jp-delete-confirm-question',
      text: '确定要删除这条 memo 吗？',
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

    // Audio file list (only when deleting with audio)
    if (this.opts.audioPaths.length > 0) {
      const audioBlock = contentEl.createDiv({ cls: 'jp-delete-confirm-audio' });
      audioBlock.createEl('div', {
        cls: 'jp-delete-confirm-audio-label',
        text: '附带删除的录音文件（移入回收站，可恢复）：',
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
