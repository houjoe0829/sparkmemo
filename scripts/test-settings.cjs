(async () => {
/* Run with node scripts/test-settings.cjs. No browser or extra test dependency. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const esbuild = require('esbuild');

// Small DOM/Obsidian doubles keep these tests independent of a running vault.
// They exercise render structure and callbacks, not layout or visual acceptance.
let focused;
const ownerDocument = { testDocument: true };
class Element {
  constructor(tag = 'div', opts = {}) {
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attrs = { ...opts.attr };
    this.classes = new Set((opts.cls || '').split(' ').filter(Boolean));
    this.listeners = {};
    this.ownText = opts.text || '';
    this.value = opts.value || opts.attr?.value || '';
    this.classList = { add: (...names) => this.addClass(...names), remove: (...names) => names.forEach(name => this.classes.delete(name)) };
  }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.ownText = value; this.children = []; }
  createEl(tag, opts) {
    const child = new Element(tag, typeof opts === 'string' ? { cls: opts } : opts);
    this.children.push(child);
    return child;
  }
  createDiv(opts) { return this.createEl('div', opts); }
  createSpan(opts) { return this.createEl('span', opts); }
  addClass(...names) { names.forEach(name => this.classes.add(name)); }
  removeClass(...names) { names.forEach(name => this.classes.delete(name)); }
  toggleClass(name, enabled) { if (enabled) this.classes.add(name); else this.classes.delete(name); }
  setCssStyles(styles) { this.styles = { ...this.styles, ...styles }; }
  setText(value) { this.textContent = value; }
  empty() { this.children = []; this.ownText = ''; }
  hide() { this.hidden = true; }
  show() { this.hidden = false; }
  isShown() { return !this.hidden; }
  setAttribute(key, value) { this.attrs[key] = value; }
  setAttr(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(key, fn) { (this.listeners[key] ??= []).push(fn); }
  click() { return Promise.all((this.listeners.click || []).map(fn => fn({}))); }
  key(key) {
    const event = { key, prevented: false, preventDefault() { this.prevented = true; } };
    (this.listeners.keydown || []).forEach(fn => fn(event));
    return event;
  }
  focus() { focused = this; }
  getBoundingClientRect() { return { left: 0, bottom: 30 }; }
  querySelectorAll(selector) {
    const matches = el => {
      if (/^[a-z]+$/.test(selector) && el.tagName !== selector) return false;
      const className = selector.match(/^\.([\w-]+)/)?.[1];
      if (className && !el.classes.has(className)) return false;
      for (const [, key, value] of selector.matchAll(/\[([\w-]+)="([^"]+)"\]/g)) {
        if (el.attrs[key] !== value) return false;
      }
      return true;
    };
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Control {
  constructor(parent, tag = 'input') { this.el = parent.createEl(tag); this.el.component = this; }
  setValue(value) { this.value = value; return this; }
  setPlaceholder(value) { this.placeholder = value; return this; }
  setLimits(...limits) { this.limits = limits; return this; }
  onChange(fn) { this.change = fn; return this; }
}
class Button {
  constructor(parent) { this.buttonEl = parent.createEl('button'); this.buttonEl.component = this; }
  setButtonText(text) { this.buttonEl.setText(text); return this; }
  setTooltip(text) { this.tooltip = text; return this; }
  onClick(fn) { this.buttonEl.addEventListener('click', fn); return this; }
}
class Setting {
  constructor(parent) {
    this.settingEl = parent.createDiv({ cls: 'setting-item' });
    this.settingEl.setting = this;
    this.nameEl = this.settingEl.createDiv({ cls: 'setting-item-name' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }
  setName(name) { this.name = name; this.nameEl.setText(name); return this; }
  setDesc(desc) { this.desc = desc; return this; }
  setHeading() { this.heading = true; return this; }
  addText(fn) { fn(new Control(this.controlEl)); return this; }
  addColorPicker(fn) { fn(new Control(this.controlEl)); return this; }
  addToggle(fn) { fn(new Control(this.controlEl)); return this; }
  addSlider(fn) { fn(new Control(this.controlEl)); return this; }
  addButton(fn) { fn(new Button(this.controlEl)); return this; }
}
class Menu {
  static latest;
  constructor() { this.items = []; Menu.latest = this; }
  addItem(fn) {
    const item = {
      setTitle(title) { this.title = title; return this; },
      setChecked(checked) { this.checked = checked; return this; },
      onClick(callback) { this.callback = callback; return this; },
    };
    fn(item); this.items.push(item); return this;
  }
  onHide(fn) { this.hideCallback = fn; }
  showAtPosition(position, doc) { this.position = position; this.document = doc; }
  async choose(title) {
    const item = this.items.find(item => item.title === title);
    assert.ok(item, `Missing menu option: ${title}`);
    try { await item.callback(); } finally { this.hideCallback?.(); }
  }
}
class TFolder { constructor(path) { this.path = path; } }
class FuzzySuggestModal {
  constructor() { this.modalEl = new Element(); }
  setPlaceholder(value) { this.placeholder = value; }
  open() { FuzzySuggestModal.latest = this; }
}
let hostLanguage = 'zh';
let legacyHost = false;
let momentLanguage = 'zh-cn';
const notices = [];
const registeredIcons = new Map();
const obsidian = {
  Setting, Menu, TFolder, FuzzySuggestModal, normalizePath: path => path,
  Platform: { isMacOS: true, isMobile: false, isIosApp: false },
  Scope: class {
    constructor(parent) { this.parent = parent; this.bindings = []; }
    register(modifiers, key, callback) { this.bindings.push({ modifiers, key, callback }); }
  },
  Plugin: class { constructor(app) { this.app = app; } },
  Component: class {}, ItemView: class {}, Modal: class { constructor() { this.modalEl = new Element(); } }, MarkdownView: class {},
  PluginSettingTab: class {
    constructor(app) { this.app = app; this.containerEl = new Element(); }
  },
  getLanguage: () => { if (legacyHost) throw Error('Not available'); return hostLanguage; },
  moment: Object.assign(() => ({ year: () => 2026 }), { locale: () => momentLanguage }),
  addIcon: (id, svg) => registeredIcons.set(id, svg),
  setIcon: (el, icon) => { el.icon = icon; },
  Notice: class { constructor(message) { notices.push(typeof message === 'string' ? message : message.textContent); } },
};
const root = path.resolve(__dirname, '..');
const output = (await esbuild.build({
  stdin: {
    contents: `export * from './src/i18n'; export { SparkMemoSettingTab, FolderSuggestModal } from './src/settings-tab'; export { DEFAULT_SETTINGS } from './src/section'; export { default as SparkMemoPlugin } from './src/main'; export { JournalCaptureView, CalendarPickerModal, ImageMetadataConfirmModal, DeleteConfirmModal, TagRenameModal, TagPickerModal, TagDeleteConfirmModal, ImagePreviewModal } from './src/capture-view'; export { SendToMyClaudianModal } from './src/send-to-myclaudian-modal';`,
    resolveDir: root,
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['obsidian', '@codemirror/*'],
  plugins: [{ name: 'test-calendar-export', setup(build) {
    build.onLoad({ filter: /capture-view\.ts$/ }, ({ path: file }) => ({
      contents: require('node:fs').readFileSync(file, 'utf8') + '\nexport { CalendarPickerModal, ImageMetadataConfirmModal, DeleteConfirmModal, TagRenameModal, TagPickerModal, TagDeleteConfirmModal, ImagePreviewModal };', loader: 'ts',
    }));
    build.onLoad({ filter: /settings-tab\.ts$/ }, ({ path: file }) => ({
      contents: require('node:fs').readFileSync(file, 'utf8') + '\nexport { FolderSuggestModal };', loader: 'ts',
    }));
  } }],
  loader: { '.wasm': 'binary' },
  define: { __PLUGIN_VERSION__: JSON.stringify('0.2.6'), __BUILD_NUMBER__: JSON.stringify('test-build') },
})).outputFiles[0].text;
const loaded = { exports: {} };
const runtimeWindow = {
  app: { internalPlugins: { plugins: { 'daily-notes': { enabled: true } } }, plugins: { getPlugin: () => null } },
  setTimeout: () => 0, clearTimeout() {},
};
const runtimeNavigator = { mediaDevices: { getUserMedia: async () => { throw Error('No test microphone'); } } };
class TestMediaRecorder {
  static latest;
  static isTypeSupported() { return false; }
  constructor(stream) { this.stream = stream; this.state = 'inactive'; TestMediaRecorder.latest = this; }
  start() { this.state = 'recording'; }
}

vm.runInNewContext(output, {
  module: loaded, exports: loaded.exports,
  require: name => name === 'obsidian' ? obsidian : require(name),
  Buffer, URL, Blob, document: ownerDocument, window: runtimeWindow, navigator: runtimeNavigator, MediaRecorder: TestMediaRecorder, performance,
  activeDocument: {
    createDocumentFragment: () => new Element('fragment'),
    documentElement: { style: { setProperty() {} } },
  },
});
const { SparkMemoPlugin, SparkMemoSettingTab, JournalCaptureView, CalendarPickerModal, DEFAULT_SETTINGS, normalizeLanguage, setLanguage, currentLocale, t } = loaded.exports;
const plain = value => JSON.parse(JSON.stringify(value));

function setup(overrides = {}) {
  hostLanguage = 'zh'; legacyHost = false; momentLanguage = 'zh-cn';
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, ...overrides }, saved: [],
    activateCaptureView() { throw Error('Settings must not recreate capture views'); },
    async saveSettings() { this.saved.push(plain(this.settings)); setLanguage(this.settings.language); },
  };
  const app = { vault: {
    config: { attachmentFolderPath: 'Attachments' },
    getAllFolders: () => [new TFolder('Photos'), new TFolder('Audio')],
  } };
  setLanguage(plugin.settings.language);
  const tab = new SparkMemoSettingTab(app, plugin);
  tab.display();
  return { tab, plugin, app, root: tab.containerEl };
}
const tabs = root => root.querySelectorAll('[role="tab"]');
const rows = root => root.querySelectorAll('.setting-item').map(el => el.setting);
const row = (root, name) => { const found = rows(root).find(item => item.name === name); assert.ok(found, name); return found; };
const control = item => item.controlEl.children.find(el => el.component)?.component;

test('defaults and invalid preferences preserve the system-language behavior', () => {
  assert.equal(DEFAULT_SETTINGS.language, 'system');
  for (const value of [undefined, null, 'system', 'fr', '', 7]) assert.equal(normalizeLanguage(value), 'system');
  assert.equal(normalizeLanguage('en'), 'en'); assert.equal(normalizeLanguage('zh'), 'zh');
  setLanguage('system'); hostLanguage = 'zh-TW'; assert.equal(currentLocale(), 'zh-TW');
  hostLanguage = 'fr'; assert.equal(currentLocale(), 'en');
});
test('manual language overrides host language without changing global locales', () => {
  setup();
  setLanguage('en'); assert.equal(currentLocale(), 'en'); assert.equal(t('settings.tabs.general'), 'General');
  assert.equal(hostLanguage, 'zh'); assert.equal(momentLanguage, 'zh-cn');
  hostLanguage = 'en'; setLanguage('zh'); assert.equal(t('settings.tabs.general'), '通用');
  assert.equal(t('missing.translation'), 'missing.translation');
  assert.equal(t('notice.writeFailed', { error: 'sentinel' }).includes('sentinel'), true);
});
test('older Obsidian falls back to moment language only in system mode', () => {
  setup(); legacyHost = true; setLanguage('system');
  assert.equal(currentLocale(), 'zh'); momentLanguage = 'en'; assert.equal(currentLocale(), 'en');
  setLanguage('zh'); assert.equal(currentLocale(), 'zh'); legacyHost = false;
});
test('four tabs render in order with General initially selected', () => {
  const { root } = setup();
  assert.deepEqual(tabs(root).map(el => el.textContent), ['通用', '时间戳', '媒体', '关于']);
  assert.equal(tabs(root)[0].getAttribute('aria-selected'), 'true');
  assert.deepEqual(rows(root).map(item => item.name), ['语言', '日记标题', '标题层级']);
});
test('tab switching remembers selection without saving settings', async () => {
  const { tab, root, plugin } = setup();
  await tabs(root)[1].click(); tab.display();
  assert.equal(tabs(root)[1].getAttribute('aria-selected'), 'true');
  assert.ok(root.querySelector('.jp-settings-preview')); assert.equal(rows(root).length, 5);
  assert.equal(plugin.saved.length, 0);
});
test('keyboard navigation wraps and keeps focus and accessibility state together', () => {
  const { root } = setup();
  assert.equal(tabs(root)[0].key('ArrowLeft').prevented, true);
  assert.equal(focused, tabs(root)[3]);
  tabs(root)[3].key('Home'); assert.equal(focused, tabs(root)[0]);
  tabs(root)[0].key('End'); assert.equal(focused, tabs(root)[3]);
  tabs(root)[3].key('ArrowRight'); assert.equal(focused, tabs(root)[0]);
  assert.equal(root.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), tabs(root)[0].getAttribute('id'));
});
test('language menu shows five options with the current choice checked', async () => {
  const { root } = setup(); const button = root.querySelector('.jp-settings-select');
  await button.click();
  assert.deepEqual(Menu.latest.items.map(item => item.title), ['跟随 Obsidian', '简体中文', '繁體中文', 'English', '日本語']);
  assert.deepEqual(Menu.latest.items.map(item => item.checked), [true, false, false, false, false]);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  await Menu.latest.choose('跟随 Obsidian'); assert.equal(button.getAttribute('aria-expanded'), 'false');
});
test('language change persists and refreshes settings without changing other values or recreating capture views', async () => {
  const { root, plugin } = setup({ imageFolder: 'Photos', timestampColor: '#123456' });
  const before = plain(plugin.settings);
  await root.querySelector('.jp-settings-select').click();
  await Menu.latest.choose('English');
  assert.equal(plugin.saved.length, 1); assert.equal(plugin.saved[0].language, 'en');
  assert.deepEqual(plain(plugin.settings), { ...before, language: 'en' });
  assert.deepEqual(tabs(root).map(el => el.textContent), ['General', 'Timestamps', 'Media', 'About']);
  assert.equal(hostLanguage, 'zh'); assert.equal(momentLanguage, 'zh-cn');
  await root.querySelector('.jp-settings-select').click(); await Menu.latest.choose('Follow Obsidian');
  assert.equal(tabs(root)[0].textContent, '通用');
});
test('failed language save restores preference and leaves the current interface unchanged', async () => {
  const { root, plugin } = setup(); plugin.saveSettings = async () => { throw Error('Disk full'); };
  await root.querySelector('.jp-settings-select').click();
  await assert.rejects(Menu.latest.choose('English'), /Disk full/);
  assert.equal(plugin.settings.language, 'system'); assert.equal(currentLocale(), 'zh');
  assert.equal(tabs(root)[0].textContent, '通用');
});
test('heading level remains editable through six themed-menu options', async () => {
  const { root, plugin } = setup();
  await control(row(root, '标题层级')).buttonEl.click();
  assert.equal(Menu.latest.items.length, 6); assert.equal(Menu.latest.items[1].checked, true);
  await Menu.latest.choose('H3  ###'); assert.equal(plugin.settings.headingLevel, 3);
  assert.equal(plugin.saved.length, 1);
});
test('timestamp settings retain color, toggle, regular-expression validation and preview', async () => {
  const { root, plugin } = setup(); await tabs(root)[1].click();
  await control(row(root, t('settings.timestampColor.name'))).change('#ffffff');
  await control(row(root, t('settings.timestampBgColor.name'))).change('#000000');
  await control(row(root, t('settings.readonly.name'))).change(false);
  await control(row(root, t('settings.autoTimestamp.name'))).change(false);
  assert.equal(plugin.settings.timestampColor, '#ffffff'); assert.equal(plugin.settings.timestampBgColor, '#000000');
  assert.equal(plugin.settings.readonlyTimestamps, false); assert.equal(plugin.settings.autoTimestamp, false);
  const pattern = control(row(root, t('settings.pattern.name')));
  const before = plugin.settings.timestampPattern; const saves = plugin.saved.length;
  await pattern.change('['); assert.equal(plugin.settings.timestampPattern, before); assert.equal(plugin.saved.length, saves);
  assert.ok(notices.at(-1).includes('无效'));
  await pattern.change('\\d{1,2}:\\d{2}'); assert.equal(plugin.settings.timestampPattern, '\\d{1,2}:\\d{2}');
  assert.ok(root.querySelector('.jp-settings-preview').textContent.includes('07:31'));
});
test('media groups preserve saved values, paths and all image controls', async () => {
  const { root, plugin } = setup({ imageFolder: 'Photos', recordingFolder: 'Audio', imageCompressionQuality: 0.65 });
  await tabs(root)[2].click();
  assert.deepEqual(rows(root).filter(item => item.heading).map(item => item.name), ['保存位置', '图片处理']);
  assert.equal(rows(root).length, 8);
  const image = control(row(root, t('settings.imageFolder.name')));
  assert.equal(image.value, 'Photos'); assert.equal(image.placeholder, 'Attachments');
  await image.change('  Pictures  '); assert.equal(plugin.settings.imageFolder, 'Pictures');
  assert.equal(control(row(root, t('settings.recordingFolder.name'))).value, 'Audio');
  assert.equal(control(row(root, t('settings.compressionQuality.name'))).value, 0.65);
  await control(row(root, t('settings.imageCompression.name'))).change(false);
  await control(row(root, t('settings.compressionQuality.name'))).change(0.9);
  await control(row(root, t('settings.compressionMaxSize.name'))).change('1280');
  await control(row(root, t('settings.imageTimeCheck.name'))).change(false);
  assert.equal(plugin.settings.imageCompressionEnabled, false); assert.equal(plugin.settings.imageCompressionQuality, 0.9);
  assert.equal(plugin.settings.imageCompressionMaxSize, 1280); assert.equal(plugin.settings.imageTimeCheck, false);
});
test('folder picker keeps existing selection and fallback semantics', async () => {
  const { root, plugin, app, tab } = setup(); await tabs(root)[2].click();
  const image = row(root, t('settings.imageFolder.name'));
  await image.controlEl.children.find(el => el.component?.buttonEl).click();
  assert.deepEqual(plain(FuzzySuggestModal.latest.getItems()), ['/', 'Audio', 'Photos']);
  FuzzySuggestModal.latest.onChooseItem('/'); await Promise.resolve();
  assert.equal(plugin.settings.imageFolder, '/'); assert.equal(control(image).value, '/');
  app.vault.config.attachmentFolderPath = '.'; tab.display();
  assert.equal(control(row(root, t('settings.imageFolder.name'))).placeholder, t('settings.attachmentFolder.sameAsNote'));
});
test('About centers title, compact version and two buttons without setting-row cards', async () => {
  const { root, plugin } = setup(); await tabs(root)[3].click();
  assert.equal(rows(root).length, 0);
  assert.equal(root.querySelector('.jp-settings-about-title').textContent, 'Spark Memo');
  assert.equal(root.querySelector('.jp-settings-about-version').textContent, 'v0.2.6 · 构建 test-build');
  assert.deepEqual(root.querySelectorAll('.jp-settings-about-btn').map(e => e.textContent), ['', '']);
  assert.equal(root.querySelector('.jp-settings-about-actions').children.length, 2);
  assert.equal(root.querySelector('.jp-settings-about').textContent.includes('https://'), false);
  assert.equal(plugin.saved.length, 0); assert.equal(root.querySelector('.jp-settings-version'), null);
});
test('About title reuses the product sparkle beside the smaller name without extra labels or settings writes', async () => {
  for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
    const { root, plugin } = setup({ language });
    await tabs(root)[3].click();
    const title = root.querySelector('.jp-settings-about-title');
    const icon = title.children[0];
    assert.equal(title.children.length, 2);
    assert.ok(icon.classes.has('jp-settings-about-product-icon'));
    assert.equal(icon.icon, 'sparkle');
    assert.equal(icon.icon, JournalCaptureView.prototype.getIcon());
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.getAttribute('title'), undefined);
    assert.equal(icon.getAttribute('aria-label'), undefined);
    assert.ok(title.children[1].classes.has('jp-settings-about-title-text'));
    assert.equal(title.children[1].textContent, 'Spark Memo');
    assert.equal(title.textContent, 'Spark Memo');
    assert.equal(plugin.saved.length, 0);
  }
  const css = require('node:fs').readFileSync(path.join(root, 'styles.css'), 'utf8');
  const titleRule = css.match(/\.jp-settings \.jp-settings-about-title\s*\{([^}]*)\}/)[1];
  assert.match(titleRule, /font-size:\s*24px;/);
  assert.match(titleRule, /display:\s*flex;/);
  assert.match(titleRule, /align-items:\s*center;/);
  assert.match(titleRule, /justify-content:\s*center;/);
  assert.match(titleRule, /gap:\s*8px;/);
  assert.match(css, /\.jp-settings \.jp-settings-about-product-icon \.svg-icon\s*\{[^}]*width:\s*24px !important;[^}]*height:\s*24px !important;/s);
});

test('opening every tab does not alter a legacy configuration', async () => {
  const legacy = plain(DEFAULT_SETTINGS); delete legacy.language;
  const { root, plugin } = setup(legacy); const before = plain(plugin.settings);
  for (let index = 0; index < 4; index++) await tabs(root)[index].click();
  assert.deepEqual(plain(plugin.settings), before); assert.equal(plugin.saved.length, 0);
  assert.equal(plugin.settings.language, 'system');
});
test('actual plugin load merges old settings without writing or losing custom values', async () => {
  setup();
  const plugin = new SparkMemoPlugin({});
  plugin.loadData = async () => ({ targetHeading: 'Journal', timestampColor: '#123456', futureSetting: 'keep' });
  plugin.saveData = async () => { throw Error('Loading must not write settings'); };
  await plugin.loadSettings();
  assert.equal(plugin.settings.language, 'system'); assert.equal(currentLocale(), 'zh');
  assert.equal(plugin.settings.targetHeading, 'Journal'); assert.equal(plugin.settings.timestampColor, '#123456');
  assert.equal(plugin.settings.futureSetting, 'keep');
});
test('actual plugin loads explicit or invalid language preferences safely', async () => {
  setup();
  const plugin = new SparkMemoPlugin({});
  plugin.loadData = async () => ({ language: 'en' });
  await plugin.loadSettings(); assert.equal(currentLocale(), 'en');
  plugin.loadData = async () => ({ language: 'unsupported' });
  await plugin.loadSettings(); assert.equal(plugin.settings.language, 'system'); assert.equal(currentLocale(), 'zh');
});
test('actual plugin save persists language and retains the existing editor refresh', async () => {
  setup(); let refreshes = 0; let saved;
  const plugin = new SparkMemoPlugin({ workspace: { iterateAllLeaves() { refreshes++; } } });
  plugin.loadData = async () => ({ imageFolder: 'Pictures' });
  plugin.saveData = async value => { saved = plain(value); };
  await plugin.loadSettings(); plugin.settings.language = 'en';
  await plugin.saveSettings();
  assert.equal(saved.language, 'en'); assert.equal(saved.imageFolder, 'Pictures');
  assert.equal(currentLocale(), 'en'); assert.equal(refreshes, 1);
  assert.equal(hostLanguage, 'zh'); assert.equal(momentLanguage, 'zh-cn');
});

function statsView(language = 'zh') {
  setup(); setLanguage(language);
  const calls = [];
  // Exercise the real stats scaffold without creating or reading a daily note.
  const view = Object.create(JournalCaptureView.prototype);
  view.statsPaneEl = new Element();
  view.app = { setting: {
    open() { calls.push('open'); },
    openTabById(id) { calls.push(`tab:${id}`); },
  } };
  view.plugin = { manifest: { id: 'spark-memo' } };
  view.buildStatsPane();
  return { view, calls, button: view.statsPaneEl.querySelector('.jp-stats-settings-btn') };
}
test('stats settings button occupies the existing left spacer and retains year/body structure', () => {
  const { view, button, calls } = statsView();
  assert.ok(button); assert.equal(button.tagName, 'button');
  assert.equal(button.getAttribute('type'), 'button'); assert.equal(button.icon, 'settings');
  assert.equal(view.statsToolbarEl.children[0].children[0], button);
  assert.ok(view.statsToolbarEl.children[0].classes.has('jp-stats-toolbar-spacer'));
  assert.equal(view.statsToolbarEl.children[1], view.statsYearLabelEl);
  assert.equal(view.statsYearLabelEl.textContent, '2026 年');
  assert.equal(view.statsPaneEl.children[1], view.statsBodyEl);
  assert.equal(view.statsToolbarEl.children.length, 2); assert.deepEqual(calls, []);
});
test('stats settings background is transparent until hover, scoped above host button defaults without changing focus or dimensions', () => {
  const css = require('node:fs').readFileSync(path.join(root, 'styles.css'), 'utf8');
  const base = css.match(/\.jp-stats-toolbar \.jp-stats-settings-btn\s*\{([^}]*)\}/)[1];
  const hover = css.match(/\.jp-stats-toolbar \.jp-stats-settings-btn:hover\s*\{([^}]*)\}/)[1];
  const focus = css.match(/\.jp-stats-toolbar \.jp-stats-settings-btn:focus-visible\s*\{([^}]*)\}/)[1];
  assert.match(base, /background:\s*transparent;/);
  assert.match(hover, /background:\s*var\(--background-modifier-hover\);/);
  assert.match(base, /width:\s*28px !important;/);
  assert.match(base, /height:\s*100% !important;/);
  assert.match(base, /padding:\s*0 !important;/);
  assert.match(focus, /outline:\s*2px solid var\(--interactive-accent\);/);
  assert.match(css, /\.is-mobile \.jp-stats-toolbar \.jp-stats-settings-btn\s*\{[^}]*width:\s*32px !important;/s);
  assert.deepEqual(hover.trim().split('\n').map(line => line.trim()), ['background: var(--background-modifier-hover);']);
});

test('stats settings button opens Obsidian settings before targeting Spark Memo', async () => {
  const { view, calls, button } = statsView();
  const body = view.statsBodyEl; const year = view.statsYearLabelEl;
  await button.click();
  assert.deepEqual(calls, ['open', 'tab:spark-memo']);
  assert.equal(view.statsBodyEl, body); assert.equal(view.statsYearLabelEl, year);
});
test('stats settings button has localized accessibility labels without hover tooltips', () => {
  const chinese = statsView('zh').button;
  const english = statsView('en').button;
  assert.equal(chinese.getAttribute('aria-label'), '打开 Spark Memo 设置');
  assert.equal(english.getAttribute('aria-label'), 'Open Spark Memo settings');
  assert.equal(chinese.getAttribute('title'), undefined); assert.equal(english.getAttribute('title'), undefined);
  assert.equal(chinese.getAttribute('data-tooltip-position'), undefined);
});
test('stats settings entry tolerates unavailable internal settings APIs', async () => {
  const { view, button } = statsView();
  view.app = {}; await assert.doesNotReject(button.click());
  view.app = { setting: {} }; await assert.doesNotReject(button.click());
});

test('traditional Chinese and Japanese selections persist and localize all four settings tabs', async () => {
  for (const [name, locale, expected] of [
    ['繁體中文', 'zh-TW', ['通用', '時間戳', '媒體', '關於']],
    ['日本語', 'ja', ['一般', 'タイムスタンプ', 'メディア', '情報']],
  ]) {
    const { root, plugin, tab } = setup({ imageFolder: 'Photos', recordingFolder: 'Audio' });
    const before = plain(plugin.settings);
    await root.querySelector('.jp-settings-select').click(); await Menu.latest.choose(name);
    assert.equal(plugin.saved[0].language, locale); assert.equal(currentLocale(), locale);
    assert.deepEqual(plain(plugin.settings), { ...before, language: locale });
    assert.deepEqual(tabs(root).map(el => el.textContent), expected);
    for (let i = 1; i < 4; i++) {
      await tabs(root)[i].click();
      assert.equal(tabs(root)[i].getAttribute('aria-selected'), 'true');
      assert.ok(!root.textContent.includes('settings.'));
    }
    tab.display(); assert.equal(tabs(root)[3].getAttribute('aria-selected'), 'true');
    assert.equal(hostLanguage, 'zh'); assert.equal(momentLanguage, 'zh-cn');
  }
});
test('failed new-language saves leave preferences and UI untouched', async () => {
  for (const name of ['繁體中文', '日本語']) {
    const { root, plugin } = setup(); plugin.saveSettings = async () => { throw Error('Disk full'); };
    await root.querySelector('.jp-settings-select').click();
    await assert.rejects(Menu.latest.choose(name), /Disk full/);
    assert.equal(plugin.settings.language, 'system'); assert.equal(currentLocale(), 'zh');
    assert.equal(tabs(root)[0].textContent, '通用');
  }
});

test('real calendar rendering uses plugin-specific month and weekday formats without altering host moment', async () => {
  const moment = require('moment');
  require('moment/locale/zh-cn'); require('moment/locale/zh-tw'); require('moment/locale/ja');
  const stub = obsidian.moment;
  try {
    obsidian.moment = moment;
    for (const [locale, title, weekdays] of [
      ['zh', '2026年1月', ['日', '一', '二', '三', '四', '五', '六']],
      ['zh-TW', '2026年1月', ['日', '一', '二', '三', '四', '五', '六']],
      ['ja', '2026年1月', ['日', '月', '火', '水', '木', '金', '土']],
      ['en', 'January 2026', ['S', 'M', 'T', 'W', 'T', 'F', 'S']],
    ]) {
      setup(); moment.locale(locale === 'en' ? 'zh-cn' : 'en');
      const original = moment.locale(); setLanguage(locale);
      const modal = Object.create(CalendarPickerModal.prototype);
      modal.contentEl = new Element(); modal.selected = moment('2026-01-15');
      modal.viewMonth = modal.selected.clone().startOf('month');
      modal.getMonthEntryDays = async () => new Set(['2026-01-15']);
      const picks = []; modal.onPick = date => picks.push(date.format('YYYY-MM-DD')); modal.close = () => {};
      await modal.renderMonth();
      assert.equal(modal.contentEl.querySelector('.jp-cal-title').textContent, title);
      assert.deepEqual(modal.contentEl.querySelectorAll('.jp-cal-weekday').map(el => el.textContent), weekdays);
      const cells = modal.contentEl.querySelectorAll('.jp-cal-cell').filter(el => !el.classes.has('is-empty'));
      assert.equal(cells.length, 31); assert.ok(cells[14].classes.has('has-entries'));
      await cells[14].click(); assert.deepEqual(picks, ['2026-01-15']);
      assert.equal(moment.locale(), original);
    }
  } finally { obsidian.moment = stub; }
});
test('stats rendering separates 萬/万 units and localizes heatmap dates independently of host language', () => {
  const moment = require('moment');
  const stub = obsidian.moment;
  try {
    obsidian.moment = moment;
    for (const [locale, unit, month, firstDate] of [
      ['zh', '万', '1月', '2026年1月1日'], ['zh-TW', '萬', '1月', '2026年1月1日'],
      ['ja', '万', '1月', '2026年1月1日'], ['en', 'words', 'Jan', 'Jan 1, 2026'],
    ]) {
      setup(); moment.locale(locale === 'en' ? 'zh-cn' : 'en');
      const original = moment.locale(); setLanguage(locale);
      const view = Object.create(JournalCaptureView.prototype);
      view.statsBodyEl = new Element(); view.statsLocationCount = 1;
      view.allTimeStats = { totalWords: 32000, writingDays: 1, totalEntries: 1, longestStreak: 1, yearsWithData: [2026] };
      view.allYearStats = new Map([[2026, { year: 2026, totalWords: 32000, totalEntries: 1,
        totalAudios: 0, writingDays: 1, dailyMap: new Map([['2026-01-01', { entryCount: 1, wordCount: 32000 }]]) }]]);
      view.renderStatsContent();
      assert.equal(view.statsBodyEl.querySelector('.jp-stats-hero-unit').textContent, unit);
      assert.equal(view.statsBodyEl.querySelector('.jp-stats-monthlabel').textContent, month);
      const cells = view.statsBodyEl.querySelectorAll('.jp-stats-cell').filter(el => el.getAttribute('title'));
      assert.equal(cells.length, 365); assert.ok(cells[0].getAttribute('title').startsWith(firstDate));
      assert.ok(view.statsBodyEl.querySelector('.jp-stats-footer').textContent.includes('32,000'));
      assert.equal(moment.locale(), original);
    }
  } finally { obsidian.moment = stub; }
});

test('select menus use the owning settings document in a separate window', async () => {
  const { root } = setup();
  const button = root.querySelector('.jp-settings-select');
  const popoutDocument = { settingsWindow: true };
  button.ownerDocument = popoutDocument;
  await button.click();
  assert.equal(Menu.latest.document, popoutDocument);
});

test('About icon links preserve exact destinations, accessible names and safe browser-opening attributes in every language', async () => {
  for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
    const { root, plugin } = setup({ language });
    const before = plain(plugin.settings);
    await tabs(root)[3].click();
    const links = root.querySelectorAll('.jp-settings-about-link');
    assert.deepEqual(links.map(e => e.getAttribute('href')), [
      'https://github.com/houjoe0829/sparkmemo', 'https://x.com/houjoe1',
    ]);
    assert.deepEqual(links.map(e => e.textContent), ['', '']);
    assert.deepEqual(links.map(e => e.getAttribute('aria-label')), [
      `${t('settings.about.github')} · ${t('settings.about.repository')}`,
      `${t('settings.about.x')} · ${t('settings.about.authorX')}`,
    ]);
    assert.deepEqual(links.map(e => e.children[0].icon), ['spark-memo-github', 'spark-memo-x']);
    for (const link of links) {
      assert.equal(link.children.length, 1);
      assert.equal(link.children[0].getAttribute('aria-hidden'), 'true');
      assert.equal(link.getAttribute('title'), undefined);
      const svg = registeredIcons.get(link.children[0].icon);
      assert.match(svg, /<path fill="currentColor" d="M/);
      assert.match(svg, /scale\(4\.1666666667\)/);
      assert.ok(!/<(?:script|image)|https?:|onload=/.test(svg));
    }
    for (const link of links) {
      assert.equal(link.getAttribute('target'), '_blank');
      assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    }
    assert.deepEqual(plain(plugin.settings), before); assert.equal(plugin.saved.length, 0);
  }
});

test('About brand icon buttons keep equal compact geometry and scoped theme-aware SVG styles', () => {
  const css = require('node:fs').readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = css.match(/\.jp-settings \.jp-settings-about-btn\s*\{([^}]*)\}/)[1];
  assert.match(rule, /width:\s*38px/); assert.match(rule, /height:\s*38px/);
  assert.match(rule, /display:\s*inline-flex/); assert.match(rule, /align-items:\s*center/);
  assert.match(rule, /justify-content:\s*center/); assert.match(rule, /padding:\s*0/);
  assert.match(css, /\.jp-settings \.jp-settings-about-icon \.svg-icon\s*\{[^}]*width:\s*18px !important;[^}]*height:\s*18px !important;[^}]*stroke:\s*none/s);
});
test('settings and folder pickers suppress hover hints without losing folder selection or localized names', async () => {
  for (const locale of ['zh', 'zh-TW', 'en', 'ja']) {
    const { root, plugin } = setup({ language: locale });
    assert.ok(root.classes.has('jp-no-tooltip'));
    await tabs(root)[2].click();
    const buttons = root.querySelectorAll('button').filter(el => el.textContent === '📁');
    assert.equal(buttons.length, 2);
    for (const button of buttons) {
      assert.equal(button.getAttribute('aria-label'), t('settings.folderPicker.tooltip'));
      assert.equal(button.getAttribute('title'), undefined); assert.equal(button.component.tooltip, undefined);
    }
    await buttons[0].click();
    assert.ok(FuzzySuggestModal.latest.modalEl.classes.has('jp-no-tooltip'));
    FuzzySuggestModal.latest.onChooseItem('Photos'); await Promise.resolve();
    assert.equal(plugin.settings.imageFolder, 'Photos');
  }
});

test('About includes one approved paragraph without a list between version and link buttons', async () => {
  const expected = {"zh": "Spark Memo 是一款 Obsidian 日记插件，支持用文字、照片和录音快速记录日常，按照片的拍摄时间与地点补记，并通过年度热力图和离线世界地图回顾记录。", "en": "Spark Memo is an Obsidian journaling plugin for capturing everyday moments with text, photos, and audio. Use a photo’s original time and location to record past moments, and revisit your entries through yearly heatmaps and an offline world map.", "zh-TW": "Spark Memo 是一款 Obsidian 日記外掛，支援用文字、照片和錄音快速記錄日常，按照片的拍攝時間與地點補記，並透過年度熱力圖和離線世界地圖回顧記錄。", "ja": "Spark Memo は、テキスト・写真・音声で日々の出来事をすばやく記録できる Obsidian の日記プラグインです。写真の撮影日時と場所を使って過去の出来事を記録し、年間ヒートマップやオフラインの世界地図で振り返ることができます。"};
  for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
    const { root, plugin } = setup({ language });
    await tabs(root)[3].click();
    const about = root.querySelector('.jp-settings-about');
    const description = root.querySelector('.jp-settings-about-description');
    assert.equal(about.children[2], description);
    assert.equal(about.children[3], root.querySelector('.jp-settings-about-actions'));
    assert.deepEqual(description.children.map(e => e.tagName), ['p']);
    assert.equal(description.children[0].textContent, t('settings.about.intro'));
    assert.equal(description.children[0].textContent, expected[language]);
    assert.equal(description.querySelectorAll('ol').length, 0);
    assert.equal(description.querySelectorAll('li').length, 0);
    assert.equal(plugin.saved.length, 0);
    assert.equal(root.querySelectorAll('.jp-settings-about-btn').length, 2);
  }
});

test('language setting uses only the approved one-sentence scope description', () => {
  for (const [language, label, description] of [
    ['zh', '语言', '设置 Spark Memo 的界面和新获取地名的语言。'],
    ['en', 'Language', 'Sets the language for Spark Memo’s interface and newly retrieved place names.'],
  ]) {
    const { root, plugin } = setup({ language });
    const setting = row(root, label);
    assert.equal(setting.desc, description);
    assert.equal(plugin.saved.length, 0);
  }
});

test('plugin startup initializes the geocoder without querying locations or writing notes/settings', async () => {
  setup();
  const reads = [], writes = [], cleanups = [], registrations = [];
  const previousRequest = obsidian.requestUrl;
  let requests = 0;
  obsidian.requestUrl = async () => { requests++; throw Error('Startup must not query locations'); };
  try {
    const plugin = new SparkMemoPlugin({ vault: { configDir: '.custom', adapter: {
      exists: async path => { reads.push(path); return false; },
      read: async () => { throw Error('No cache exists'); },
      write: async (...args) => { writes.push(args); },
    } } });
    plugin.manifest = { id: 'spark-memo', name: 'Spark Memo', dir: '.custom/plugins/spark-memo' };
    plugin.loadData = async () => ({ language: 'en' });
    plugin.saveData = async () => { throw Error('Startup must not save settings'); };
    plugin.register = fn => cleanups.push(fn);
    plugin.registerEditorExtension = () => {};
    plugin.registerMarkdownPostProcessor = () => {};
    plugin.addSettingTab = () => registrations.push('settings');
    plugin.registerView = () => registrations.push('capture');
    plugin.addCommand = () => {};
    plugin.addRibbonIcon = () => new Element('button');
    await plugin.onload();
    await Promise.resolve();
    assert.deepEqual(reads, ['.custom/plugins/spark-memo/geocode-cache.json']);
    assert.equal(cleanups.length, 1);
    assert.equal(requests, 0); assert.equal(writes.length, 0);
    assert.deepEqual(registrations, ['settings', 'capture']);
    cleanups.forEach(fn => fn());
  } finally { obsidian.requestUrl = previousRequest; }
});

})().catch(error => { console.error(error); process.exitCode = 1; });
