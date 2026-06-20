import {
  App,
  MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  ObsidianProtocolData,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  moment,
} from 'obsidian';
import {
  EditorState,
  Extension,
  Prec,
  StateEffect,
  Transaction,
} from '@codemirror/state';
import {
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  keymap,
} from '@codemirror/view';
import {
  appHasDailyNotesPluginLoaded,
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
} from 'obsidian-daily-notes-interface';

import {
  DEFAULT_SETTINGS,
  JournalPartnerSettings,
  appendToJournalSection,
  buildDecorations,
  buildEntryLine,
  findSection,
  generateTimestamp,
  getTimestampRanges,
} from './section';
import { CAPTURE_VIEW_TYPE, JournalCaptureView } from './capture-view';

// ── CM6 utilities ───────────────────────────────────────────────────────────

/** Effect that forces decoration recomputation after settings change. */
const forceUpdateEffect = StateEffect.define<null>();

// ── Plugin ──────────────────────────────────────────────────────────────────

export default class JournalPartnerPlugin extends Plugin {
  settings: JournalPartnerSettings;

  async onload() {
    await this.loadSettings();
    this.applyCSSVariables();
    this.updateCheckboxStyle();
    this.registerEditorExtension(this.createEditorExtensions());
    this.registerMarkdownPostProcessor(this.postProcessor.bind(this));
    this.addSettingTab(new JournalPartnerSettingTab(this.app, this));

    // Capture sidebar view
    this.registerView(
      CAPTURE_VIEW_TYPE,
      leaf => new JournalCaptureView(leaf, this),
    );
    this.addCommand({
      id: 'open-capture-view',
      name: '打开快速记录侧边栏',
      callback: () => void this.activateCaptureView(),
    });
    this.addRibbonIcon('feather', '快速记录', () => void this.activateCaptureView());

    // ── URL protocol handler (Path B: Action Button + Shortcuts) ──
    // Registers obsidian://journal-partner so that an iOS Shortcut (or any
    // tool that can open URLs) can write to today's `## Journal` section
    // without opening the capture view or any other UI.
    //
    // Usage (from a Shortcut):
    //   obsidian://journal-partner?action=quickcapture&text=<urlencoded>
    //   obsidian://journal-partner?action=quickcapture&text=<...>&time=15:30
    this.registerObsidianProtocolHandler('journal-partner', params => {
      void this.handleProtocol(params);
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(CAPTURE_VIEW_TYPE);
  }

  /**
   * Reveal an existing capture view leaf, or create one.
   *
   * - **Mobile** — Obsidian's right sidebar pins views in a drawer the user
   *   can't pop out, which makes the timeline feel cramped. Open in the
   *   main work area instead so it gets full-screen treatment.
   * - **Desktop** — keep the right sidebar so the capture view stays a
   *   persistent companion next to whatever the user is editing.
   */
  async activateCaptureView() {
    const existing = this.app.workspace.getLeavesOfType(CAPTURE_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf: WorkspaceLeaf | null = Platform.isMobile
      ? this.app.workspace.getLeaf(true)
      : this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: CAPTURE_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  // ── Quick-capture write path (shared) ─────────────────────────────────────

  /**
   * Append a single entry to today's `## Journal` section.
   *
   * Used by both the in-app capture textarea and the URL protocol handler.
   * Creates today's daily note and the journal heading if they don't exist
   * yet.
   *
   * @param text     Raw user content (may contain newlines).
   * @param ts       Timestamp string in `HH:MM` form. Defaults to now.
   * @returns        true on success, false if Daily Notes plugin is missing
   *                 or the write fails.
   */
  async writeToTodayJournal(text: string, ts?: string): Promise<boolean> {
    if (!appHasDailyNotesPluginLoaded()) {
      new Notice('请先启用 Obsidian 自带的「Daily Notes」核心插件');
      return false;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;

    const stamp = ts ?? generateTimestamp();
    const line = buildEntryLine(trimmed.replace(/\r\n/g, '\n'), stamp);

    try {
      let file = getDailyNote(moment(), getAllDailyNotes()) as TFile | null;
      if (!file) {
        file = (await createDailyNote(moment())) as TFile;
      }
      await this.app.vault.process(file, content =>
        appendToJournalSection(content, this.settings, line),
      );
      return true;
    } catch (err) {
      console.error('[Journal Partner] writeToTodayJournal failed', err);
      new Notice(`写入失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Handle `obsidian://journal-partner?...` URLs.
   *
   * Recognised actions:
   *   - `quickcapture`: append `text` to today's journal. Optional `time`
   *     overrides the timestamp (must match HH:MM); otherwise the current
   *     local time is used. Shows a Notice on success/failure but does NOT
   *     open or focus any view — designed for Action Button workflows that
   *     should feel ambient.
   */
  private async handleProtocol(params: ObsidianProtocolData): Promise<void> {
    const action = params.action;
    if (action !== 'quickcapture') {
      new Notice(`未知动作：${action}`);
      return;
    }

    const text = params.text ?? '';
    if (text.trim().length === 0) {
      new Notice('Quick capture 缺少 text 参数');
      return;
    }

    const time = params.time;
    const tsValid = typeof time === 'string' && /^\d{2}:\d{2}$/.test(time);
    const ts = tsValid ? time : undefined;

    const ok = await this.writeToTodayJournal(text, ts);
    if (ok) {
      const preview = text.trim().replace(/\s+/g, ' ').slice(0, 20);
      new Notice(`📝 已记录：${preview}${text.length > 20 ? '…' : ''}`);
    }
  }

  // ── Editor extension (source + live-preview) ───────────────────────────────

  private createEditorExtensions(): Extension[] {
    const plugin = this;

    // ViewPlugin renders timestamp decorations
    const viewPlugin = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(
            view.state.doc.toString(),
            plugin.settings,
          );
        }

        update(update: ViewUpdate) {
          const needsRebuild =
            update.docChanged ||
            update.viewportChanged ||
            update.transactions.some(tr =>
              tr.effects.some(e => e.is(forceUpdateEffect)),
            );
          if (needsRebuild) {
            this.decorations = buildDecorations(
              update.state.doc.toString(),
              plugin.settings,
            );
          }
        }
      },
      { decorations: v => v.decorations },
    );

    // Transaction filter: reject changes that overlap a timestamp range
    const readonlyFilter = EditorState.transactionFilter.of(
      (tr: Transaction) => {
        if (!plugin.settings.readonlyTimestamps || !tr.docChanged) return tr;

        const timestamps = getTimestampRanges(
          tr.startState.doc.toString(),
          plugin.settings,
        );
        let blocked = false;

        tr.changes.iterChanges((fromA, toA) => {
          if (blocked) return;
          for (const { from, to } of timestamps) {
            if (fromA < to && toA > from) {
              blocked = true;
              break;
            }
          }
        });

        if (blocked) {
          new Notice('⏰ 时间戳不可修改');
          return []; // reject the transaction
        }

        return tr;
      },
    );

    return [viewPlugin, readonlyFilter, this.createEnterKeymap(), this.createTabKeymap()];
  }

  /**
   * Returns a high-priority keymap extension that intercepts Enter inside the
   * target section.
   */
  private createEnterKeymap(): Extension {
    const plugin = this;

    return Prec.high(
      keymap.of([
        {
          key: 'Enter',
          run(view: EditorView): boolean {
            if (!plugin.settings.autoTimestamp) return false;

            const state = view.state;
            const doc = state.doc.toString();
            const section = findSection(
              doc,
              plugin.settings.targetHeading,
              plugin.settings.headingLevel,
            );
            if (!section) return false;

            const cursor = state.selection.main;
            if (cursor.head < section.from || cursor.head > section.to) {
              return false;
            }

            const line = state.doc.lineAt(cursor.head);

            const indentMatch = line.text.match(/^(\s*)/);
            const currentIndent = indentMatch?.[1] ?? '';
            const isNested = currentIndent.length > 0;

            const markerMatch = line.text.match(/^\s*([-*+]\s+)/);
            const listMarker = markerMatch ? markerMatch[1] : '';

            if (!listMarker) return false;

            let insertion: string;

            if (isNested) {
              insertion = '\n' + currentIndent + listMarker;
            } else {
              const ts = generateTimestamp();
              insertion = '\n' + listMarker + ts + ' ';
            }

            view.dispatch(
              state.update({
                changes: { from: cursor.from, to: cursor.to, insert: insertion },
                selection: { anchor: cursor.from + insertion.length },
                scrollIntoView: true,
              }),
            );

            return true;
          },
        },
      ]),
    );
  }

  /**
   * Returns a high-priority keymap extension that intercepts Tab inside the
   * target section.
   */
  private createTabKeymap(): Extension {
    const plugin = this;

    return Prec.high(
      keymap.of([
        {
          key: 'Tab',
          run(view: EditorView): boolean {
            const state = view.state;
            const doc = state.doc.toString();
            const section = findSection(
              doc,
              plugin.settings.targetHeading,
              plugin.settings.headingLevel,
            );
            if (!section) return false;

            const cursor = state.selection.main;
            if (cursor.head < section.from || cursor.head > section.to) {
              return false;
            }

            const line = state.doc.lineAt(cursor.head);

            const indentMatch = line.text.match(/^(\s*)/);
            const currentIndent = indentMatch?.[1] ?? '';
            const isTopLevel = currentIndent.length === 0;

            if (!isTopLevel) return false;

            const timestampMatch = line.text.match(
              new RegExp(`^([-*+]\\s+)(${plugin.settings.timestampPattern})\\s+`),
            );

            if (!timestampMatch) return false;

            const markerAndSpace = timestampMatch[1];
            const timestampText = timestampMatch[2];

            const afterTimestampMatch = line.text.match(
              new RegExp(`^([-*+]\\s+)(${plugin.settings.timestampPattern})\\s+(.*)`),
            );
            const contentAfterTimestamp = afterTimestampMatch?.[3] ?? '';

            const newLinePrefix = '\t' + markerAndSpace + contentAfterTimestamp;

            const replaceEnd =
              line.from +
              markerAndSpace.length +
              timestampText.length +
              1 +
              contentAfterTimestamp.length;

            const changes = [
              { from: line.from, to: replaceEnd, insert: newLinePrefix },
            ];

            view.dispatch(
              state.update({
                changes,
                selection: { anchor: line.from + 1 + markerAndSpace.length },
                scrollIntoView: true,
              }),
            );

            return true;
          },
        },
      ]),
    );
  }

  // ── Reading-view post processor ────────────────────────────────────────────

  private postProcessor(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ) {
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    if (!this.isInTargetSection(info.text, info.lineStart)) return;
    this.highlightTimestampsInElement(el);
  }

  private isInTargetSection(docText: string, lineStart: number): boolean {
    const section = findSection(
      docText,
      this.settings.targetHeading,
      this.settings.headingLevel,
    );
    if (!section) return false;

    const sectionStartLine =
      docText.slice(0, section.from).split('\n').length - 1;
    const sectionEndLine =
      docText.slice(0, section.to).split('\n').length - 1;

    return lineStart >= sectionStartLine && lineStart < sectionEndLine;
  }

  private highlightTimestampsInElement(el: HTMLElement) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) textNodes.push(node as Text);

    for (const textNode of textNodes) {
      const raw = textNode.textContent ?? '';
      const m = new RegExp(this.settings.timestampPattern).exec(raw);
      if (!m) continue;

      const before = raw.slice(0, m.index);
      const after = raw.slice(m.index + m[0].length);
      const span = createEl('span', { cls: 'jp-timestamp', text: m[0] });

      const parent = textNode.parentNode!;
      if (before) parent.insertBefore(document.createTextNode(before), textNode);
      parent.insertBefore(span, textNode);
      if (after) parent.insertBefore(document.createTextNode(after), textNode);
      parent.removeChild(textNode);
    }
  }

  // ── CSS variables & settings plumbing ─────────────────────────────────────

  applyCSSVariables() {
    const root = document.documentElement;
    root.style.setProperty('--jp-ts-color', this.settings.timestampColor);
    root.style.setProperty('--jp-ts-bg', this.settings.timestampBgColor);
  }

  private updateCheckboxStyle() {
    const el = document.documentElement;
    if (this.settings.circularCheckboxes) {
      el.classList.add('jp-circular-checkboxes');
    } else {
      el.classList.remove('jp-circular-checkboxes');
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData(),
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyCSSVariables();
    this.updateCheckboxStyle();
    this.refreshEditors();
  }

  private refreshEditors() {
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cm: EditorView | undefined = (leaf.view.editor as any)?.cm;
        cm?.dispatch({ effects: forceUpdateEffect.of(null) });
      }
    });
  }
}

// ── Settings tab ────────────────────────────────────────────────────────────

class JournalPartnerSettingTab extends PluginSettingTab {
  plugin: JournalPartnerPlugin;

  constructor(app: App, plugin: JournalPartnerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Journal Partner' });

    // ── Scope ──────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '📍 作用范围' });

    new Setting(containerEl)
      .setName('目标标题名称')
      .setDesc(
        '插件生效的标题文字（不含 # 符号），例如填写 Journal 则作用于 ## Journal 下的内容',
      )
      .addText(text =>
        text
          .setPlaceholder('Journal')
          .setValue(this.plugin.settings.targetHeading)
          .onChange(async value => {
            this.plugin.settings.targetHeading = value.trim() || 'Journal';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('标题层级')
      .setDesc('目标标题的层级，H2 对应 ## Journal')
      .addDropdown(dd => {
        for (let i = 1; i <= 6; i++) {
          dd.addOption(String(i), `H${i}  ${'#'.repeat(i)}`);
        }
        dd.setValue(String(this.plugin.settings.headingLevel));
        dd.onChange(async value => {
          this.plugin.settings.headingLevel = parseInt(value);
          await this.plugin.saveSettings();
        });
      });

    // ── Style ──────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🎨 时间戳样式' });

    new Setting(containerEl)
      .setName('文字颜色')
      .setDesc('时间戳徽标的前景色')
      .addColorPicker(cp =>
        cp
          .setValue(this.plugin.settings.timestampColor)
          .onChange(async value => {
            this.plugin.settings.timestampColor = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('背景颜色')
      .setDesc('时间戳徽标的背景色')
      .addColorPicker(cp =>
        cp
          .setValue(this.plugin.settings.timestampBgColor)
          .onChange(async value => {
            this.plugin.settings.timestampBgColor = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Behavior ───────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '⚙️ 行为' });

    new Setting(containerEl)
      .setName('时间戳只读')
      .setDesc(
        '开启后，在编辑器中无法修改已存在的时间戳，防止意外删除或改动',
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.readonlyTimestamps)
          .onChange(async value => {
            this.plugin.settings.readonlyTimestamps = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('回车自动插入时间戳')
      .setDesc(
        '在 Journal 区块内按下回车时，自动在新行开头插入当前时间（HH:MM）',
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoTimestamp)
          .onChange(async value => {
            this.plugin.settings.autoTimestamp = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('圆形复选框')
      .setDesc('在日记区域内将 checkbox 渲染为圆形而非方形')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.circularCheckboxes)
          .onChange(async value => {
            this.plugin.settings.circularCheckboxes = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Advanced ───────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🔧 高级' });

    new Setting(containerEl)
      .setName('时间戳匹配正则')
      .setDesc(
        '用于识别时间戳的正则表达式。默认匹配 HH:MM 格式（如 07:31）。' +
          '修改后立即生效，无效的正则会被忽略。',
      )
      .addText(text =>
        text
          .setPlaceholder('\\d{2}:\\d{2}')
          .setValue(this.plugin.settings.timestampPattern)
          .onChange(async value => {
            try {
              new RegExp(value); // validate before saving
              this.plugin.settings.timestampPattern = value;
              await this.plugin.saveSettings();
            } catch {
              new Notice('❌ 无效的正则表达式，请检查后重试');
            }
          }),
      );

    // Preview badge
    const previewEl = containerEl.createDiv({ cls: 'jp-settings-preview' });
    previewEl.style.cssText =
      'margin-top: 24px; padding: 16px; border-radius: 8px;' +
      'background: var(--background-secondary); display: flex; align-items: center; gap: 10px;';
    previewEl.createEl('span', { text: '预览：' }).style.color =
      'var(--text-muted)';
    previewEl.createEl('span', {
      cls: 'jp-timestamp',
      text: '07:31',
    });
    previewEl.createEl('span', { text: '这里是日记内容…' });
  }
}
