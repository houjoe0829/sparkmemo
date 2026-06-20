/**
 * Quick-capture sidebar view.
 *
 * Three-section layout:
 *   1. Toolbar — refresh + sort toggle
 *   2. Input card — multi-line textarea + NOTE submit button
 *   3. Timeline — vertical line connecting timestamped entries
 *
 * Reads today's daily note (via obsidian-daily-notes-interface) and renders
 * the entries inside the configured `## Journal` section. Submitting writes
 * `- HH:MM text` to the same section, creating the file or heading if needed.
 */

import { Component, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, moment, setIcon } from 'obsidian';
import {
  appHasDailyNotesPluginLoaded,
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
} from 'obsidian-daily-notes-interface';

import {
  JournalEntry,
  appendToJournalSection,
  buildEntryLine,
  findSection,
  generateTimestamp,
  parseJournalEntries,
} from './section';
import type JournalPartnerPlugin from './main';

export const CAPTURE_VIEW_TYPE = 'journal-partner-capture-view';

type EmptyReason = 'no-daily-plugin' | 'no-file' | 'no-section' | 'no-entries' | null;

export class JournalCaptureView extends ItemView {
  private plugin: JournalPartnerPlugin;

  // DOM references
  private toolbarEl!: HTMLElement;
  private inputCardEl!: HTMLElement;
  private timelineEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private submitBtn!: HTMLButtonElement;
  private sortBtn!: HTMLButtonElement;

  // Cached state for rerender filtering
  private todayFile: TFile | null = null;
  private rerenderTimer: number | null = null;
  /** Per-render lifecycle owner for MarkdownRenderer.render children. */
  private renderScope: Component | null = null;

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
    return 'clock';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('jp-capture-root');

    this.buildToolbar(root as HTMLElement);
    this.buildInputCard(root as HTMLElement);
    this.buildTimeline(root as HTMLElement);

    // Watch the vault — only rerender when today's file changes
    this.registerEvent(
      this.app.vault.on('modify', file => {
        if (file instanceof TFile && this.todayFile && file.path === this.todayFile.path) {
          this.scheduleRerender();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('create', file => {
        // A new daily note may have been created externally; refresh
        if (file instanceof TFile && file.extension === 'md') {
          this.scheduleRerender();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (this.todayFile && file instanceof TFile && file.path === this.todayFile.path) {
          this.todayFile = null;
          this.scheduleRerender();
        }
      }),
    );

    await this.rerender();
  }

  async onClose(): Promise<void> {
    if (this.rerenderTimer !== null) {
      window.clearTimeout(this.rerenderTimer);
      this.rerenderTimer = null;
    }
    if (this.renderScope) {
      this.renderScope.unload();
      this.renderScope = null;
    }
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
      void this.rerender();
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
      await this.rerender();
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
        placeholder: 'What do you think now…',
        rows: '3',
      },
    });
    this.textareaEl.addEventListener('input', () => {
      this.refreshSubmitState();
      this.autoResizeTextarea();
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

  private scheduleRerender() {
    if (this.rerenderTimer !== null) return;
    this.rerenderTimer = window.setTimeout(() => {
      this.rerenderTimer = null;
      void this.rerender();
    }, 80);
  }

  private async rerender(): Promise<void> {
    // Tear down any markdown-rendered children from the previous pass so
    // their listeners (image loaders, link hover, etc.) are released.
    if (this.renderScope) {
      this.renderScope.unload();
      this.renderScope = null;
    }
    this.timelineEl.empty();

    if (!appHasDailyNotesPluginLoaded()) {
      this.renderEmpty('no-daily-plugin');
      return;
    }

    let file: TFile | null = null;
    try {
      file = getDailyNote(moment(), getAllDailyNotes()) as TFile | null;
    } catch (err) {
      console.error('[Journal Partner] failed to resolve today daily note', err);
      this.renderEmpty('no-daily-plugin');
      return;
    }
    this.todayFile = file ?? null;

    if (!file) {
      this.renderEmpty('no-file');
      return;
    }

    let content: string;
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (err) {
      console.error('[Journal Partner] failed to read today daily note', err);
      this.renderEmpty('no-file');
      return;
    }

    const section = findSection(
      content,
      this.plugin.settings.targetHeading,
      this.plugin.settings.headingLevel,
    );
    if (!section) {
      this.renderEmpty('no-section');
      return;
    }

    const sectionText = content.slice(section.from, section.to);
    const entries = parseJournalEntries(sectionText, this.plugin.settings.timestampPattern);
    if (entries.length === 0) {
      this.renderEmpty('no-entries');
      return;
    }

    this.renderEntries(entries);
  }

  private renderEmpty(reason: EmptyReason) {
    // Always render the date-header node so users see today's marker even
    // when there are no entries yet.
    if (reason !== 'no-daily-plugin') {
      const headerLabel = this.formatDateHeader(this.todayFile);
      const headerRow = this.timelineEl.createDiv({
        cls: 'jp-timeline-entry jp-timeline-entry--header',
      });
      headerRow.createDiv({ cls: 'jp-timeline-dot jp-timeline-dot--header' });
      const headerCard = headerRow.createDiv({ cls: 'jp-timeline-header-card' });
      headerCard.createEl('div', { cls: 'jp-timeline-header-title', text: headerLabel.title });
      if (headerLabel.subtitle) {
        headerCard.createEl('div', { cls: 'jp-timeline-header-sub', text: headerLabel.subtitle });
      }
    }

    const wrap = this.timelineEl.createDiv({ cls: 'jp-capture-empty' });
    let msg = '';
    switch (reason) {
      case 'no-daily-plugin':
        msg = '请先启用 Obsidian 自带的「Daily Notes」核心插件';
        break;
      case 'no-file':
        msg = '今天还没有日记，写点什么吧 →';
        break;
      case 'no-section':
        msg = `今天的日记里还没有 ${'#'.repeat(
          this.plugin.settings.headingLevel,
        )} ${this.plugin.settings.targetHeading} 区块，提交后将自动创建`;
        break;
      case 'no-entries':
        msg = '区块为空，写点什么吧 →';
        break;
      default:
        msg = '暂无内容';
    }
    wrap.createEl('p', { text: msg });
  }

  private renderEntries(entries: JournalEntry[]) {
    // Each render owns its own Component so MarkdownRenderer.render attaches
    // child lifecycles (link/image handlers) that we can tear down on the
    // next refresh.
    const scope = new Component();
    scope.load();
    this.renderScope = scope;

    // Date header — first node on the timeline, gets a distinct dot style.
    const file = this.todayFile;
    const headerLabel = this.formatDateHeader(file);
    const headerRow = this.timelineEl.createDiv({ cls: 'jp-timeline-entry jp-timeline-entry--header' });
    headerRow.createDiv({ cls: 'jp-timeline-dot jp-timeline-dot--header' });
    const headerCard = headerRow.createDiv({ cls: 'jp-timeline-header-card' });
    headerCard.createEl('div', { cls: 'jp-timeline-header-title', text: headerLabel.title });
    if (headerLabel.subtitle) {
      headerCard.createEl('div', { cls: 'jp-timeline-header-sub', text: headerLabel.subtitle });
    }

    // Sorting: timeline display order. The "latest" dot decoration is keyed
    // by timestamp value (max) so it stays visually correct in either direction.
    const latestTs = entries.reduce<string>((acc, e) => (e.timestamp > acc ? e.timestamp : acc), '');

    const sorted = [...entries].sort((a, b) => {
      // Stable secondary key: source line index preserves authoring order
      // when timestamps tie.
      if (a.timestamp === b.timestamp) {
        return this.plugin.settings.captureSortDesc
          ? b.lineIndex - a.lineIndex
          : a.lineIndex - b.lineIndex;
      }
      return this.plugin.settings.captureSortDesc
        ? a.timestamp < b.timestamp ? 1 : -1
        : a.timestamp < b.timestamp ? -1 : 1;
    });

    const sourcePath = file?.path ?? '';
    for (const entry of sorted) {
      const row = this.timelineEl.createDiv({ cls: 'jp-timeline-entry' });

      const dot = row.createDiv({ cls: 'jp-timeline-dot' });
      if (entry.timestamp === latestTs) {
        dot.addClass('jp-timeline-dot--latest');
      }

      const card = row.createDiv({ cls: 'jp-timeline-card' });
      const header = card.createDiv({ cls: 'jp-timeline-card-header' });
      header.createEl('span', { cls: 'jp-timestamp', text: entry.timestamp });

      const body = card.createDiv({ cls: 'jp-timeline-card-body' });
      // Render the entry body as markdown so wikilinks, embedded images,
      // bold/italic, etc. render the same as in the editor.
      void MarkdownRenderer.render(this.app, entry.text, body, sourcePath, scope);
    }
  }

  /** Build a human-readable date label for the timeline header node. */
  private formatDateHeader(file: TFile | null): { title: string; subtitle?: string } {
    const m = moment();
    // moment.locale defaults to en; we render Chinese labels manually so we
    // don't depend on the user's locale being zh.
    const weekdayZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][m.day()];
    const title = m.format('YYYY年M月D日') + ` · ${weekdayZh}`;
    const subtitle = file ? file.basename : '今天还没有日记';
    return { title, subtitle };
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
      // Normalize line endings inside textarea before parsing
      const ts = generateTimestamp();
      const line = buildEntryLine(raw.replace(/\r\n/g, '\n'), ts);

      // 1. Resolve or create today's daily note
      let file = getDailyNote(moment(), getAllDailyNotes()) as TFile | null;
      if (!file) {
        file = (await createDailyNote(moment())) as TFile;
      }

      // 2. Append the entry to the journal section, creating the heading if absent
      await this.app.vault.process(file, content =>
        appendToJournalSection(content, this.plugin.settings, line),
      );

      // 3. Clean up UI — vault.modify event will trigger rerender
      this.textareaEl.value = '';
      this.autoResizeTextarea();
      this.todayFile = file;
    } catch (err) {
      console.error('[Journal Partner] submit failed', err);
      new Notice(`写入失败：${err instanceof Error ? err.message : String(err)}`);
      // Keep textarea content for retry
    } finally {
      this.submitBtn.setText(originalText ?? 'NOTE');
      this.refreshSubmitState();
    }
  }
}
