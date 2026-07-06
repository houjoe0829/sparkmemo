import {
  App,
  ExtraButtonComponent,
  FuzzySuggestModal,
  MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  TextComponent,
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
  SparkMemoSettings,
  appendToJournalSection,
  buildDecorations,
  buildEntryLine,
  findSection,
  generateTimestamp,
  getTimestampRanges,
} from './section';
import { CAPTURE_VIEW_TYPE, JournalCaptureView } from './capture-view';
import { t } from './i18n';

// ── CM6 utilities ───────────────────────────────────────────────────────────

/** Effect that forces decoration recomputation after settings change. */
const forceUpdateEffect = StateEffect.define<null>();

// ── Plugin ──────────────────────────────────────────────────────────────────

export default class SparkMemoPlugin extends Plugin {
  settings: SparkMemoSettings;

  async onload() {
    await this.loadSettings();
    this.applyCSSVariables();
    this.registerEditorExtension(this.createEditorExtensions());
    this.registerMarkdownPostProcessor(this.postProcessor.bind(this));
    this.addSettingTab(new SparkMemoSettingTab(this.app, this));

    // Capture sidebar view
    this.registerView(
      CAPTURE_VIEW_TYPE,
      leaf => new JournalCaptureView(leaf, this),
    );
    this.addCommand({
      id: 'open-capture-view',
      name: t('command.openCaptureView'),
      callback: () => void this.activateCaptureView(),
    });
    this.addRibbonIcon('feather', t('ribbon.captureView'), () => void this.activateCaptureView());
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
   * Append a single entry to a daily note's `## Journal` section.
   *
   * Used by the in-app capture textarea. Creates the target day's daily note
   * and the journal heading if they don't exist yet.
   *
   * @param text       Raw user content (may contain newlines).
   * @param ts         Timestamp string in `HH:MM` form. Defaults to now.
   * @param audio      Optional vault-relative path to an audio attachment;
   *                   when provided, ` ![[path]]` is appended to the entry.
   * @param targetDate Which day's daily note to write into. Defaults to
   *                   today — set when the entry is backdated to an image's
   *                   capture date.
   * @returns          true on success, false if Daily Notes plugin is
   *                   missing or the write fails.
   */
  async writeJournalEntry(
    text: string,
    ts?: string,
    audio?: string,
    targetDate?: moment.Moment,
  ): Promise<boolean> {
    if (!appHasDailyNotesPluginLoaded()) {
      new Notice(t('notice.dailyNotesRequired'));
      return false;
    }
    const trimmed = text.trim();
    const audioPath = audio?.trim() ?? '';
    // Require at least one of text / audio — an entry with neither is junk.
    if (trimmed.length === 0 && audioPath.length === 0) return false;

    const stamp = ts ?? generateTimestamp();
    // Embed the audio as a wiki-link so Obsidian renders the inline player.
    // Single-line entries get a trailing ` ![[path]]`; multi-line text uses
    // buildEntryLine to keep markdown soft-breaks, then we append on the
    // first line (which is the only one with the timestamp anchor).
    const body = audioPath.length > 0
      ? `${trimmed}${trimmed.length > 0 ? ' ' : ''}![[${audioPath}]]`
      : trimmed;
    const line = buildEntryLine(body.replace(/\r\n/g, '\n'), stamp);
    const day = targetDate ?? moment();

    try {
      let file = getDailyNote(day, getAllDailyNotes()) as TFile | null;
      if (!file) {
        file = (await createDailyNote(day)) as TFile;
      }
      await this.app.vault.process(file, content =>
        appendToJournalSection(content, this.settings, line),
      );
      return true;
    } catch (err) {
      console.error('[Spark Memo] writeJournalEntry failed', err);
      new Notice(t('notice.writeFailed', { error: err instanceof Error ? err.message : String(err) }));
      return false;
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
          new Notice(t('notice.timestampReadonly'));
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

class SparkMemoSettingTab extends PluginSettingTab {
  plugin: SparkMemoPlugin;

  constructor(app: App, plugin: SparkMemoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Collect all vault folder paths, sorted and deduplicated. */
  private getFolderPaths(): string[] {
    const folders = this.app.vault
      .getAllFolders()
      .filter((file): file is TFolder => file instanceof TFolder);
    const folderPaths = folders.map((folder) => (folder.path === '' ? '/' : folder.path));
    if (!folderPaths.includes('/')) {
      folderPaths.unshift('/');
    }
    return Array.from(new Set(folderPaths)).sort();
  }

  /**
   * Best-effort synchronous read of Obsidian's configured attachment folder,
   * for the settings placeholder so users see the real fallback (not a
   * hard-coded "Attachments") when they leave the field blank.
   *
   * `app.getConfig('attachmentFolderPath')` returns undefined on some Obsidian
   * versions, so we read the in-memory vault config object directly — it's a
   * plain property access, cheap and safe to call during settings render.
   * Special values: `.` = same folder as the note, `/` or empty = vault root.
   */
  private attachmentFolderLabel(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const folder = (this.app as any).vault?.config?.attachmentFolderPath as
      | string
      | undefined;
    if (!folder || folder === '/' || folder === '') return t('settings.attachmentFolder.vaultRoot');
    if (folder === '.') return t('settings.attachmentFolder.sameAsNote');
    return folder;
  }

  /**
   * A folder-picker setting row shared by the recording and image folders: a
   * text field (placeholder = Obsidian's real attachment folder) plus a 📁
   * button that opens the fuzzy folder-suggest modal. `key` selects which
   * settings field to read/write.
   */
  private addFolderSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: 'recordingFolder' | 'imageFolder',
  ): void {
    let textComp: TextComponent | null = null;
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText(text => {
        textComp = text;
        text
          .setPlaceholder(this.attachmentFolderLabel())
          .setValue(this.plugin.settings[key])
          .onChange(async value => {
            this.plugin.settings[key] = value.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton(btn => {
        btn
          .setButtonText('📁')
          .setTooltip(t('settings.folderPicker.tooltip'))
          .onClick(() => {
            const modal = this.createFolderSuggestModal((path: string) => {
              this.plugin.settings[key] = path;
              void this.plugin.saveSettings();
              textComp?.setValue(path);
            });
            modal.open();
          });
      });
  }

  /** Creates a FuzzySuggestModal pre-populated with vault folder paths. */
  private createFolderSuggestModal(onSelect: (value: string) => void): FolderSuggestModal {
    const folders = this.getFolderPaths();
    return new FolderSuggestModal(this.app, folders, onSelect);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: t('settings.title') });

    // ── Timestamp Settings ────────────────────────────────────────────────
    containerEl.createEl('h3', { text: t('settings.timestamp.heading') });

    new Setting(containerEl)
      .setName(t('settings.targetHeading.name'))
      .setDesc(t('settings.targetHeading.desc'))
      .addText(text =>
        text
          .setPlaceholder('Memo')
          .setValue(this.plugin.settings.targetHeading)
          .onChange(async value => {
            this.plugin.settings.targetHeading = value.trim() || 'Memo';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('settings.headingLevel.name'))
      .setDesc(t('settings.headingLevel.desc'))
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

    new Setting(containerEl)
      .setName(t('settings.timestampColor.name'))
      .setDesc(t('settings.timestampColor.desc'))
      .addColorPicker(cp =>
        cp
          .setValue(this.plugin.settings.timestampColor)
          .onChange(async value => {
            this.plugin.settings.timestampColor = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('settings.timestampBgColor.name'))
      .setDesc(t('settings.timestampBgColor.desc'))
      .addColorPicker(cp =>
        cp
          .setValue(this.plugin.settings.timestampBgColor)
          .onChange(async value => {
            this.plugin.settings.timestampBgColor = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('settings.readonly.name'))
      .setDesc(t('settings.readonly.desc'))
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.readonlyTimestamps)
          .onChange(async value => {
            this.plugin.settings.readonlyTimestamps = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('settings.autoTimestamp.name'))
      .setDesc(t('settings.autoTimestamp.desc'))
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoTimestamp)
          .onChange(async value => {
            this.plugin.settings.autoTimestamp = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('settings.pattern.name'))
      .setDesc(t('settings.pattern.desc'))
      .addText(text =>
        text
          .setPlaceholder('\\d{2}:\\d{2}')
          .setValue(this.plugin.settings.timestampPattern)
          .onChange(async value => {
            try {
              new RegExp(value);
              this.plugin.settings.timestampPattern = value;
              await this.plugin.saveSettings();
            } catch {
              new Notice(t('notice.invalidRegex'));
            }
          }),
      );

    // Preview badge
    const previewEl = containerEl.createDiv({ cls: 'jp-settings-preview' });
    previewEl.style.cssText =
      'margin-top: 24px; padding: 16px; border-radius: 8px;' +
      'background: var(--background-secondary); display: flex; align-items: center; gap: 10px;';
    previewEl.createEl('span', { text: t('settings.preview.label') }).style.color =
      'var(--text-muted)';
    previewEl.createEl('span', {
      cls: 'jp-timestamp',
      text: '07:31',
    });
    previewEl.createEl('span', { text: t('settings.preview.sampleText') });

    // ── Speech-to-text ────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: t('settings.stt.heading') });

    this.addFolderSetting(
      containerEl,
      t('settings.recordingFolder.name'),
      t('settings.recordingFolder.desc'),
      'recordingFolder',
    );

    // ── Cloud transcription settings (hidden for now — local recording only) ──
    // let apiKeyInputEl: HTMLInputElement | null = null;
    //
    // new Setting(containerEl)
    //   .setName('转写地址')
    //   .setDesc('OpenAI 兼容的 /audio/transcriptions 地址。留空则关闭录音转文字。')
    //   .addText(text =>
    //     text
    //       .setPlaceholder('https://api.openai.com/v1/audio/transcriptions')
    //       .setValue(this.plugin.settings.sttEndpoint)
    //       .onChange(async value => {
    //         this.plugin.settings.sttEndpoint = value.trim();
    //         await this.plugin.saveSettings();
    //       }),
    //   );
    //
    // new Setting(containerEl)
    //   .setName('API Key')
    //   .setDesc('以 Bearer 形式发送的密钥。可填 OpenAI / Groq / 自建服务的密钥。')
    //   .addText(text => {
    //     text.inputEl.type = 'password';
    //     apiKeyInputEl = text.inputEl;
    //     text
    //       .setPlaceholder('sk-…')
    //       .setValue(this.plugin.settings.sttApiKey)
    //       .onChange(async value => {
    //         this.plugin.settings.sttApiKey = value.trim();
    //         await this.plugin.saveSettings();
    //       });
    //     return text;
    //   })
    //   .addExtraButton((button: ExtraButtonComponent) => {
    //     let isPassword = true;
    //     button.setIcon('eye')
    //       .setTooltip('显示/隐藏 API Key')
    //       .onClick(() => {
    //         isPassword = !isPassword;
    //         if (apiKeyInputEl) {
    //           apiKeyInputEl.type = isPassword ? 'password' : 'text';
    //         }
    //         button.setIcon(isPassword ? 'eye' : 'eye-off');
    //       });
    //     return button;
    //   });
    //
    // new Setting(containerEl)
    //   .setName('模型')
    //   .setDesc('multipart 中的 model 字段，如 whisper-1、whisper-large-v3。')
    //   .addText(text =>
    //     text
    //       .setPlaceholder('whisper-1')
    //       .setValue(this.plugin.settings.sttModel)
    //       .onChange(async value => {
    //         this.plugin.settings.sttModel = value.trim();
    //         await this.plugin.saveSettings();
    //       }),
    //   );
    //
    // new Setting(containerEl)
    //   .setName('语言')
    //   .setDesc('ISO-639-1 语言提示，如 zh、en。留空让模型自动识别。')
    //   .addText(text =>
    //     text
    //       .setPlaceholder('zh')
    //       .setValue(this.plugin.settings.sttLanguage)
    //       .onChange(async value => {
    //         this.plugin.settings.sttLanguage = value.trim();
    //         await this.plugin.saveSettings();
    //       }),
    //   );
    //
    // new Setting(containerEl)
    //   .setName('实时转写')
    //   .setDesc('录音时边说边出字，在停顿处切句并带上下文拼接。关闭则录完整段后一次性转写。')
    //   .addToggle(toggle =>
    //     toggle
    //       .setValue(this.plugin.settings.sttRealtime)
    //       .onChange(async value => {
    //         this.plugin.settings.sttRealtime = value;
    //         await this.plugin.saveSettings();
    //       }),
    //   );

    // ── Shortcut ──────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: t('settings.other.heading') });

    this.addFolderSetting(
      containerEl,
      t('settings.imageFolder.name'),
      t('settings.imageFolder.desc'),
      'imageFolder',
    );

    new Setting(containerEl)
      .setName(t('settings.imageCompression.name'))
      .setDesc(t('settings.imageCompression.desc'))
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.imageCompressionEnabled)
          .onChange(async value => {
            this.plugin.settings.imageCompressionEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('settings.compressionQuality.name'))
      .setDesc(t('settings.compressionQuality.desc'))
      .addSlider(slider =>
        slider
          .setLimits(0.1, 1, 0.05)
          .setValue(this.plugin.settings.imageCompressionQuality)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.imageCompressionQuality = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('settings.compressionMaxSize.name'))
      .setDesc(t('settings.compressionMaxSize.desc'))
      .addText(text =>
        text
          .setPlaceholder('1920')
          .setValue(String(this.plugin.settings.imageCompressionMaxSize))
          .onChange(async value => {
            const n = parseInt(value, 10);
            this.plugin.settings.imageCompressionMaxSize = Number.isFinite(n) && n >= 0 ? n : 0;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('settings.imageTimeCheck.name'))
      .setDesc(t('settings.imageTimeCheck.desc'))
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.imageTimeCheck)
          .onChange(async value => {
            this.plugin.settings.imageTimeCheck = value;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('div', {
      cls: 'jp-settings-version',
      text: `Spark Memo v${__PLUGIN_VERSION__} (build ${__BUILD_NUMBER__})`,
    });
  }
}

/** Fuzzy-suggest modal for selecting a vault folder path. */
class FolderSuggestModal extends FuzzySuggestModal<string> {
  private folders: string[];
  private onSelectFolder: (value: string) => void;

  constructor(app: App, folders: string[], onSelect: (value: string) => void) {
    super(app);
    this.folders = folders;
    this.onSelectFolder = onSelect;
    this.setPlaceholder(t('settings.folderPicker.placeholder'));
  }

  getItems(): string[] {
    return this.folders;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onSelectFolder(item);
  }
}
