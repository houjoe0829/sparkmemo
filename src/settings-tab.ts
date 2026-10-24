import { App, FuzzySuggestModal, Menu, PluginSettingTab, Setting, TFolder, TextComponent, addIcon, setIcon } from 'obsidian';
import type SparkMemoPlugin from './main';
import { normalizeLanguage, t } from './i18n';
import { LANGUAGE_PROFILES, SUPPORTED_LOCALES } from './languages';
import { notice } from './notice';

// Simple Icons brand marks, CC0-1.0. Vendored for offline use through Obsidian's icon API.
// https://api.iconify.design/simple-icons/github.svg
// https://api.iconify.design/simple-icons/x.svg
// Obsidian's icon registry uses a 100 x 100 viewBox; the source paths use 24 x 24.
const ABOUT_BRAND_ICONS = {
  'github': '<g transform="scale(4.1666666667)"><path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12c0 5.303 3.438 9.8 8.205 11.385c.6.113.82-.258.82-.577c0-.285-.01-1.04-.015-2.04c-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729c1.205.084 1.838 1.236 1.838 1.236c1.07 1.835 2.809 1.305 3.495.998c.108-.776.417-1.305.76-1.605c-2.665-.3-5.466-1.332-5.466-5.93c0-1.31.465-2.38 1.235-3.22c-.135-.303-.54-1.523.105-3.176c0 0 1.005-.322 3.3 1.23c.96-.267 1.98-.399 3-.405c1.02.006 2.04.138 3 .405c2.28-1.552 3.285-1.23 3.285-1.23c.645 1.653.24 2.873.12 3.176c.765.84 1.23 1.91 1.23 3.22c0 4.61-2.805 5.625-5.475 5.92c.42.36.81 1.096.81 2.22c0 1.606-.015 2.896-.015 3.286c0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></g>',
  'x': '<g transform="scale(4.1666666667)"><path fill="currentColor" d="M14.234 10.162L22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299l-.929-1.329L3.076 1.56h3.182l5.965 8.532l.929 1.329l7.754 11.09h-3.182z"/></g>',
} as const;

const TABS = ['general', 'timestamp', 'media', 'about'] as const;
type SettingsTab = typeof TABS[number];
let nextSettingsId = 0;

/** Settings-only rendering; tab or language changes never recreate a capture view. */
export class SparkMemoSettingTab extends PluginSettingTab {
  private currentTab: SettingsTab = 'general';
  private readonly settingsId = `spark-memo-settings-${nextSettingsId++}`;

  constructor(app: App, private plugin: SparkMemoPlugin) {
    super(app, plugin);
    for (const [name, svg] of Object.entries(ABOUT_BRAND_ICONS)) {
      addIcon(`spark-memo-${name}`, svg);
    }
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
    const vaultWithConfig = this.app.vault as unknown as {
      config?: { attachmentFolderPath?: string };
    };
    const folder = vaultWithConfig.config?.attachmentFolderPath;
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
        btn.buttonEl.setAttribute('aria-label', t('settings.folderPicker.tooltip'));
        btn
          .setButtonText('📁')
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

  /** Use Obsidian's themed menu, including its checked state and keyboard handling. */
  private addSelectSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    value: string,
    options: ReadonlyArray<readonly [string, string]>,
    onChange: (value: string) => Promise<void>,
  ): void {
    new Setting(containerEl).setName(name).setDesc(desc).addButton(button => {
      const el = button.buttonEl;
      el.addClass('jp-settings-select');
      el.setAttribute('aria-label', name);
      el.setAttribute('aria-haspopup', 'menu');
      el.setAttribute('aria-expanded', 'false');
      const label = el.createSpan({
        text: options.find(([key]) => key === value)?.[1] ?? value,
        cls: 'jp-settings-select-label',
      });
      const icon = el.createSpan({ cls: 'jp-settings-select-icon', attr: { 'aria-hidden': 'true' } });
      setIcon(icon, 'chevron-down');
      button.onClick(() => {
        const menu = new Menu();
        for (const [key, title] of options) {
          menu.addItem(item => item.setTitle(title).setChecked(key === value).onClick(async () => {
            if (key === value) return;
            await onChange(key);
            value = key;
            label.setText(title);
          }));
        }
        menu.onHide(() => el.setAttribute('aria-expanded', 'false'));
        const rect = el.getBoundingClientRect();
        el.setAttribute('aria-expanded', 'true');
        menu.showAtPosition({ x: rect.left, y: rect.bottom }, el.ownerDocument);
      });
    });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('jp-settings', 'jp-no-tooltip');
    const tabBar = containerEl.createDiv({ cls: 'jp-settings-tab-bar', attr: {
      role: 'tablist', 'aria-label': t('settings.tabs.label'),
    } });
    for (const tab of TABS) {
      const selected = this.currentTab === tab;
      const button = tabBar.createEl('button', {
        text: t(`settings.tabs.${tab}`),
        cls: `jp-settings-tab-btn${selected ? ' active' : ''}`,
        attr: {
          type: 'button', role: 'tab', id: `${this.settingsId}-${tab}`,
          'aria-selected': String(selected), 'aria-controls': `${this.settingsId}-panel`,
          tabindex: selected ? '0' : '-1',
        },
      });
      const activate = (next: SettingsTab, focus: boolean) => {
        this.currentTab = next;
        this.display();
        if (focus) containerEl.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
      };
      button.addEventListener('click', () => activate(tab, false));
      button.addEventListener('keydown', event => {
        const index = TABS.indexOf(tab);
        let next: number;
        switch (event.key) {
          case 'ArrowRight': next = (index + 1) % TABS.length; break;
          case 'ArrowLeft': next = (index + TABS.length - 1) % TABS.length; break;
          case 'Home': next = 0; break;
          case 'End': next = TABS.length - 1; break;
          default: return;
        }
        event.preventDefault();
        activate(TABS[next], true);
      });
    }
    const content = containerEl.createDiv({ cls: 'jp-settings-tab-content', attr: {
      id: `${this.settingsId}-panel`, role: 'tabpanel',
      'aria-labelledby': `${this.settingsId}-${this.currentTab}`,
    } });
    switch (this.currentTab) {
      case 'general': this.renderGeneral(content); break;
      case 'timestamp': this.renderTimestamps(content); break;
      case 'media': this.renderMedia(content); break;
      case 'about': this.renderAbout(content); break;
    }
  }

  private renderGeneral(containerEl: HTMLElement): void {
    this.addSelectSetting(
      containerEl, t('settings.language.name'), t('settings.language.desc'),
      this.plugin.settings.language,
      [
        ['system', t('settings.language.system')],
        ...SUPPORTED_LOCALES.map(value => [value, LANGUAGE_PROFILES[value].nativeName] as const),
      ],
      async value => {
        const previous = this.plugin.settings.language;
        this.plugin.settings.language = normalizeLanguage(value);
        try {
          await this.plugin.saveSettings();
        } catch (error) {
          this.plugin.settings.language = previous;
          throw error;
        }
        this.display();
        this.containerEl.querySelector<HTMLButtonElement>('.jp-settings-select')?.focus();
      },
    );
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

    this.addSelectSetting(
      containerEl, t('settings.headingLevel.name'), t('settings.headingLevel.desc'),
      String(this.plugin.settings.headingLevel),
      Array.from({ length: 6 }, (_, index) => [String(index + 1), `H${index + 1}  ${'#'.repeat(index + 1)}`] as const),
      async value => {
        this.plugin.settings.headingLevel = Number(value);
        await this.plugin.saveSettings();
      },
    );
  }

  private renderTimestamps(containerEl: HTMLElement): void {
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
              notice(t('notice.invalidRegex'));
            }
          }),
      );

    // Preview badge
    const previewEl = containerEl.createDiv({ cls: 'jp-settings-preview' });
    previewEl.createEl('span', {
      cls: 'jp-settings-preview-label',
      text: t('settings.preview.label'),
    });
    previewEl.createEl('span', {
      cls: 'jp-timestamp',
      text: '07:31',
    });
    previewEl.createEl('span', { text: t('settings.preview.sampleText') });

  }

  private renderMedia(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.media.folders')).setHeading();
    this.addFolderSetting(containerEl, t('settings.imageFolder.name'), t('settings.imageFolder.desc'), 'imageFolder');
    this.addFolderSetting(containerEl, t('settings.recordingFolder.name'), t('settings.recordingFolder.desc'), 'recordingFolder');
    new Setting(containerEl).setName(t('settings.media.images')).setHeading();
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

  }

  private renderAbout(containerEl: HTMLElement): void {
    const about = containerEl.createDiv({ cls: 'jp-settings-about' });
    const title = about.createDiv({ cls: 'jp-settings-about-title' });
    const icon = title.createSpan({ cls: 'jp-settings-about-product-icon', attr: { 'aria-hidden': 'true' } });
    setIcon(icon, 'sparkle');
    icon.querySelector('svg')?.setAttribute('focusable', 'false');
    title.createSpan({ cls: 'jp-settings-about-title-text', text: t('app.name') });
    about.createDiv({
      cls: 'jp-settings-about-version',
      text: t('settings.about.versionInfo', { version: __PLUGIN_VERSION__, build: __BUILD_NUMBER__ }),
    });
    const description = about.createDiv({ cls: 'jp-settings-about-description' });
    description.createEl('p', { text: t('settings.about.intro') });
    const actions = about.createDiv({ cls: 'jp-settings-about-actions' });
    for (const [key, labelKey, icon, url] of [
      ['settings.about.repository', 'settings.about.github', 'github', 'https://github.com/houjoe0829/sparkmemo'],
      ['settings.about.authorX', 'settings.about.x', 'x', 'https://x.com/houjoe1'],
    ]) {
      const link = actions.createEl('a', {
        cls: 'jp-settings-about-link jp-settings-about-btn',
        attr: { href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${t(labelKey)} · ${t(key)}` },
      });
      const glyph = link.createSpan({ cls: 'jp-settings-about-icon', attr: { 'aria-hidden': 'true' } });
      setIcon(glyph, `spark-memo-${icon}`);
      glyph.querySelector('svg')?.setAttribute('focusable', 'false');
    }
  }
}

/** Fuzzy-suggest modal for selecting a vault folder path. */
class FolderSuggestModal extends FuzzySuggestModal<string> {
  private folders: string[];
  private onSelectFolder: (value: string) => void;

  constructor(app: App, folders: string[], onSelect: (value: string) => void) {
    super(app);
    this.modalEl.addClass('jp-no-tooltip');
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
