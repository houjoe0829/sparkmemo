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
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  focus() { focused = this; this.ownerDocument.activeElement = this; }
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
  setCta() { this.buttonEl.addClass('mod-cta'); return this; }
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
class TestModal {
  static latest;
  constructor(app) {
    this.app = app;
    this.modalEl = new Element();
    this.titleEl = this.modalEl.createDiv();
    this.contentEl = this.modalEl.createDiv();
  }
  open() { TestModal.latest = this; this.opened = true; this.onOpen?.(); }
  close() { this.opened = false; this.onClose?.(); }
}
const clipboardWrites = [], openedUrls = [];
let clipboardError = null, emailOpenError = null;
const obsidian = {
  Setting, Menu, TFolder, FuzzySuggestModal, ButtonComponent: Button, normalizePath: path => path,
  Platform: { isMacOS: true, isMobile: false, isIosApp: false },
  Scope: class {
    constructor(parent) { this.parent = parent; this.bindings = []; }
    register(modifiers, key, callback) { this.bindings.push({ modifiers, key, callback }); }
  },
  Plugin: class { constructor(app) { this.app = app; } },
  Component: class {}, ItemView: class {}, Modal: TestModal, MarkdownView: class {},
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
const runtimeMath = Object.create(Math);
let previewDecodeFails = false;
let previewCanvas = null;
class TestImage {
  constructor() { this.naturalWidth = 2; this.naturalHeight = 2; }
  set src(value) { if (previewDecodeFails) this.onerror?.(); else this.onload?.(); }
}

const runtimeWindow = {
  app: { internalPlugins: { plugins: { 'daily-notes': { enabled: true } } }, plugins: { getPlugin: () => null } },
  setTimeout: () => 0, clearTimeout() {},
  open(url, target) { if (emailOpenError) throw emailOpenError; openedUrls.push({ url, target }); },
};
const runtimeNavigator = {
  mediaDevices: { getUserMedia: async () => { throw Error('No test microphone'); } },
  clipboard: { async writeText(text) { if (clipboardError) throw clipboardError; clipboardWrites.push(text); } },
};
class TestMediaRecorder {
  static latest;
  static isTypeSupported() { return false; }
  constructor(stream) { this.stream = stream; this.state = 'inactive'; TestMediaRecorder.latest = this; }
  start() { this.state = 'recording'; }
}

vm.runInNewContext(output, {
  module: loaded, exports: loaded.exports,
  require: name => name === 'obsidian' ? obsidian : require(name),
  Buffer, URL, Blob, Math: runtimeMath, Image: TestImage, document: ownerDocument, window: runtimeWindow, navigator: runtimeNavigator, MediaRecorder: TestMediaRecorder, performance,
  activeDocument: {
    createElement: tag => tag === 'canvas' ? previewCanvas : new Element(tag),
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
  assert.deepEqual(tabs(root).map(el => el.textContent), ['通用', '存储位置', '配置', '关于']);
  assert.equal(tabs(root)[0].getAttribute('aria-selected'), 'true');
  assert.deepEqual(rows(root).map(item => item.name), ['语言', '日记标题', '标题层级']);
});
test('daily note location is translated, explanatory only, and leads the storage tab', async () => {
  const expected = [
    ['zh', '每日笔记存放位置', 'Memo 保存在 Obsidian 的每日笔记（Daily Note）中，存放位置跟随每日笔记的设置。'],
    ['zh-TW', '每日筆記存放位置', 'Memo 儲存在 Obsidian 的每日筆記（Daily Note）中，存放位置依照每日筆記的設定。'],
    ['en', 'Daily note location', 'Memos are saved in Obsidian daily notes, following the daily note folder settings.'],
    ['ja', 'デイリーノートの保存先', 'Memo は Obsidian のデイリーノートに保存され、保存先はデイリーノートの設定に従います。'],
  ];
  for (const [language, name, description] of expected) {
    const { root, plugin } = setup({ language });
    const settings = plain(plugin.settings);
    await tabs(root)[1].click();
    const info = rows(root)[0];
    assert.equal(info.name, name);
    assert.equal(info.desc, description);
    assert.equal(info.controlEl.children.length, 0);
    assert.deepEqual(rows(root).map(item => item.name), [name, t('settings.imageFolder.name'), t('settings.recordingFolder.name')]);
    assert.equal(plugin.saved.length, 0);
    assert.deepEqual(plain(plugin.settings), settings);
    assert.ok(root.classes.has('jp-no-tooltip'));
    assert.equal(info.settingEl.getAttribute('title'), undefined);
  }
});
test('tab switching remembers selection without saving settings', async () => {
  const { tab, root, plugin } = setup();
  await tabs(root)[1].click(); tab.display();
  assert.equal(tabs(root)[1].getAttribute('aria-selected'), 'true');
  assert.deepEqual(rows(root).map(item => item.name), ['每日笔记存放位置', '图片存放位置', '录音存放位置']);
  assert.equal(root.querySelector('.jp-settings-preview'), null);
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
  assert.deepEqual(tabs(root).map(el => el.textContent), ['General', 'Storage locations', 'Configuration', 'About']);
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
  const { root, plugin } = setup(); await tabs(root)[2].click();
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
test('storage and configuration preserve saved values, paths and all image controls', async () => {
  const { root, plugin } = setup({ imageFolder: 'Photos', recordingFolder: 'Audio', imageCompressionQuality: 0.65 });
  await tabs(root)[1].click();
  assert.equal(rows(root).length, 3);
  assert.deepEqual(rows(root).filter(item => item.heading), []);
  const image = control(row(root, t('settings.imageFolder.name')));
  assert.equal(image.value, 'Photos'); assert.equal(image.placeholder, 'Attachments');
  await image.change('  Pictures  '); assert.equal(plugin.settings.imageFolder, 'Pictures');
  assert.equal(control(row(root, t('settings.recordingFolder.name'))).value, 'Audio');
  await tabs(root)[2].click();
  assert.deepEqual(rows(root).filter(item => item.heading).map(item => item.name), [t('settings.timestamp.heading'), t('settings.media.images')]);
  assert.equal(rows(root).length, 11);
  assert.equal(control(row(root, t('settings.compressionQuality.name'))).value, 0.65);
  await control(row(root, t('settings.imageCompression.name'))).change(false);
  await control(row(root, t('settings.compressionQuality.name'))).change(0.9);
  await control(row(root, t('settings.compressionMaxSize.name'))).change('1280');
  await control(row(root, t('settings.imageTimeCheck.name'))).change(false);
  assert.equal(plugin.settings.imageCompressionEnabled, false); assert.equal(plugin.settings.imageCompressionQuality, 0.9);
  assert.equal(plugin.settings.imageCompressionMaxSize, 1280); assert.equal(plugin.settings.imageTimeCheck, false);
});
test('folder picker keeps existing selection and fallback semantics', async () => {
  const { root, plugin, app, tab } = setup(); await tabs(root)[1].click();
  const image = row(root, t('settings.imageFolder.name'));
  await image.controlEl.children.find(el => el.component?.buttonEl).click();
  assert.deepEqual(plain(FuzzySuggestModal.latest.getItems()), ['/', 'Audio', 'Photos']);
  FuzzySuggestModal.latest.onChooseItem('/'); await Promise.resolve();
  assert.equal(plugin.settings.imageFolder, '/'); assert.equal(control(image).value, '/');
  app.vault.config.attachmentFolderPath = '.'; tab.display();
  assert.equal(control(row(root, t('settings.imageFolder.name'))).placeholder, t('settings.attachmentFolder.sameAsNote'));
});
test('About centers title, compact version and three buttons without setting-row cards', async () => {
  const { root, plugin } = setup(); await tabs(root)[3].click();
  assert.equal(rows(root).length, 0);
  assert.equal(root.querySelector('.jp-settings-about-title').textContent, 'Spark Memo');
  assert.equal(root.querySelector('.jp-settings-about-version').textContent, 'v0.2.6 · 构建 test-build');
  assert.deepEqual(root.querySelectorAll('.jp-settings-about-btn').map(e => e.textContent), ['', '', '']);
  assert.equal(root.querySelector('.jp-settings-about-actions').children.length, 3);
  assert.equal(root.querySelector('.jp-settings-about').textContent.includes('https://'), false);
  assert.equal(plugin.saved.length, 0); assert.equal(root.querySelector('.jp-settings-version'), null);
});
test('email icon preserves existing links and only opens a localized contact dialog', async () => {
  for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
    clipboardWrites.length = 0; openedUrls.length = 0;
    const { root, plugin } = setup({ language });
    await tabs(root)[3].click();
    assert.deepEqual(root.querySelectorAll('a').map(e => e.getAttribute('href')),
      ['https://github.com/houjoe0829/sparkmemo', 'https://x.com/houjoe1']);
    const button = root.querySelector('.jp-settings-about-email');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.getAttribute('aria-label'), t('settings.contact.title'));
    assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(button.getAttribute('title'), undefined);
    assert.equal(button.children[0].icon, 'mail');
    await button.click();
    const modal = TestModal.latest;
    assert.equal(modal.titleEl.textContent, t('settings.contact.title'));
    assert.equal(modal.contentEl.querySelector('.jp-email-contact-description').textContent, t('settings.contact.description'));
    assert.equal(modal.contentEl.querySelector('.jp-email-contact-address').textContent, 'houqiao829@gmail.com');
    assert.deepEqual(modal.contentEl.querySelectorAll('button').map(e => e.textContent),
      [t('settings.contact.copy'), t('settings.contact.open')]);
    assert.ok(modal.modalEl.classes.has('jp-no-tooltip'));
    assert.ok(modal.modalEl.classes.has('jp-email-contact-modal'));
    assert.equal(clipboardWrites.length, 0); assert.equal(openedUrls.length, 0);
    assert.equal(plugin.saved.length, 0);
    modal.close(); assert.equal(modal.contentEl.children.length, 0);
    modal.open(); assert.equal(modal.contentEl.querySelectorAll('button').length, 2);
    modal.close();
  }
});
test('copy contact email writes the exact address and reports success without opening email', async () => {
  clipboardWrites.length = 0; openedUrls.length = 0;
  const { root } = setup(); await tabs(root)[3].click();
  await root.querySelector('.jp-settings-about-email').click();
  const modal = TestModal.latest;
  await modal.contentEl.querySelectorAll('button')[0].click();
  assert.deepEqual(clipboardWrites, ['houqiao829@gmail.com']);
  assert.equal(notices.at(-1), '邮箱地址已复制');
  assert.equal(openedUrls.length, 0); assert.equal(modal.opened, true);
  modal.close();
});
test('copy failure keeps the selectable address and does not claim success or launch email', async () => {
  clipboardWrites.length = 0; openedUrls.length = 0;
  const { root } = setup(); await tabs(root)[3].click();
  await root.querySelector('.jp-settings-about-email').click();
  const modal = TestModal.latest;
  clipboardError = Error('Clipboard denied');
  try { await modal.contentEl.querySelectorAll('button')[0].click(); }
  finally { clipboardError = null; }
  assert.equal(notices.at(-1), t('settings.contact.copyFailed'));
  assert.equal(clipboardWrites.length, 0); assert.equal(openedUrls.length, 0);
  assert.equal(modal.contentEl.querySelector('.jp-email-contact-address').textContent, 'houqiao829@gmail.com');
  assert.equal(modal.opened, true); modal.close();
});
test('open email action uses mailto with only the recipient and never sends or copies automatically', async () => {
  clipboardWrites.length = 0; openedUrls.length = 0;
  const { root } = setup(); await tabs(root)[3].click();
  await root.querySelector('.jp-settings-about-email').click();
  const modal = TestModal.latest;
  await modal.contentEl.querySelectorAll('button')[1].click();
  assert.deepEqual(openedUrls, [{ url: 'mailto:houqiao829@gmail.com', target: '_blank' }]);
  assert.equal(clipboardWrites.length, 0); modal.close();
});
test('email launch errors are localized and preserve the manual copy fallback', async () => {
  openedUrls.length = 0;
  const { root } = setup(); await tabs(root)[3].click();
  await root.querySelector('.jp-settings-about-email').click();
  const modal = TestModal.latest;
  emailOpenError = Error('No mail handler');
  try { await modal.contentEl.querySelectorAll('button')[1].click(); }
  finally { emailOpenError = null; }
  assert.equal(openedUrls.length, 0);
  assert.equal(notices.at(-1), t('settings.contact.openFailed'));
  assert.equal(modal.contentEl.querySelectorAll('button').length, 2); modal.close();
});
test('email icon and dialog use scoped styles while retaining the existing brand icon treatment', () => {
  const css = require('node:fs').readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.jp-settings \.jp-settings-about-icon \.svg-icon\s*\{[^}]*stroke:\s*none;/s);
  assert.match(css, /\.jp-settings \.jp-settings-about-email \.svg-icon\s*\{[^}]*fill:\s*none;[^}]*stroke:\s*currentColor;/s);
  assert.match(css, /\.jp-email-contact-address\s*\{[^}]*user-select:\s*text;/s);
  const addressRule = css.match(/\.jp-email-contact-address\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(addressRule, /padding\s*:|border(?:-radius)?\s*:|background(?:-color)?\s*:/);
  assert.match(css, /\.jp-email-contact-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
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

test('regrouping renders every existing setting exactly once and never migrates saved values', async () => {
  for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
    const { root, plugin } = setup({ language, targetHeading: 'Journal', headingLevel: 3,
      imageFolder: 'Photos', recordingFolder: 'Audio', imageCompressionQuality: 0.65, futureSetting: 'keep' });
    const before = plain(plugin.settings);
    const groups = [
      ['settings.language.name', 'settings.targetHeading.name', 'settings.headingLevel.name'],
      ['settings.dailyNote.name', 'settings.imageFolder.name', 'settings.recordingFolder.name'],
      ['settings.timestampColor.name', 'settings.timestampBgColor.name', 'settings.readonly.name',
        'settings.autoTimestamp.name', 'settings.pattern.name', 'settings.imageCompression.name',
        'settings.compressionQuality.name', 'settings.compressionMaxSize.name', 'settings.imageTimeCheck.name'],
    ];
    const rendered = [];
    for (let index = 0; index < groups.length; index++) {
      await tabs(root)[index].click();
      const names = rows(root).filter(item => !item.heading).map(item => item.name);
      assert.deepEqual(names, groups[index].map(key => t(key)));
      rendered.push(...names);
    }
    assert.equal(new Set(rendered).size, rendered.length);
    assert.ok(root.querySelector('.jp-settings-preview'));
    assert.deepEqual(plain(plugin.settings), before);
    assert.equal(plugin.saved.length, 0);
  }
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
    ['繁體中文', 'zh-TW', ['通用', '儲存位置', '設定', '關於']],
    ['日本語', 'ja', ['一般', '保存先', '設定', '情報']],
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
      assert.equal(view.statsBodyEl.querySelector('.jp-stats-hero-num').textContent, locale === 'en' ? '32K' : '3.2');
      assert.ok(view.statsBodyEl.querySelector('.jp-stats-footer').textContent.includes(
        locale === 'zh' || locale === 'zh-TW' ? '32000' : '32,000'));
      assert.equal(moment.locale(), original);
    }
  } finally { obsidian.moment = stub; }
});

test('annual word totals preserve exact digits, grouping rules and audio summaries', () => {
  for (const locale of ['zh', 'zh-TW', 'en', 'ja']) {
    setup(); setLanguage(locale);
    for (const words of [0, 999, 1000, 9999, 123456, 1234567]) {
      for (const audios of [0, 2]) {
        const view = Object.create(JournalCaptureView.prototype);
        view.statsBodyEl = new Element();
        view.renderStatsHeatmap = () => {};
        view.renderStatsHeatmapSection(2026, {
          writingDays: 1234, totalWords: words, totalEntries: 12345, totalAudios: audios,
        });
        const wordText = locale === 'zh' || locale === 'zh-TW'
          ? String(words) : words.toLocaleString(locale === 'en' ? 'en-US' : 'ja-JP');
        assert.equal(view.statsBodyEl.querySelector('.jp-stats-footer').textContent,
          t('stats.footerSummary', { days: '1234', words: wordText, entries: '12345' })
          + (audios ? t('stats.footerAudioSuffix', { count: String(audios) }) : ''),
          `${locale}:${words}:${audios}`);
      }
    }
  }
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

test('all toolbar tabs, tag/location controls and search actions keep accessible names without native hover titles', () => {
  for (const locale of ['zh', 'zh-TW', 'en', 'ja']) {
    setup(); setLanguage(locale);
    const view = Object.create(JournalCaptureView.prototype);
    const root = new Element(); view.buildTabBar(root);
    const buttons = root.querySelectorAll('button');
    assert.equal(buttons.length, 11);
    for (const button of buttons) {
      assert.ok(button.getAttribute('aria-label'), button.textContent);
      assert.equal(button.getAttribute('title'), undefined);
      assert.equal(button.getAttribute('data-tooltip-position'), undefined);
    }
    assert.equal(view.randomMemoBtn.getAttribute('aria-label'), t('search.randomMemo'));
    view.searchInputEl.value = 'memo'; view.updateSearchActionBtn();
    assert.equal(view.randomMemoBtn.getAttribute('aria-label'), t('search.clearQuery'));
    assert.equal(view.randomMemoBtn.icon, 'x'); assert.equal(view.randomMemoBtn.getAttribute('title'), undefined);
    view.searchInputEl.value = ''; view.updateSearchActionBtn();
    assert.equal(view.randomMemoBtn.icon, 'dice'); assert.equal(view.randomMemoBtn.getAttribute('title'), undefined);
  }
});
test('settings and folder pickers suppress hover hints without losing folder selection or localized names', async () => {
  for (const locale of ['zh', 'zh-TW', 'en', 'ja']) {
    const { root, plugin } = setup({ language: locale });
    assert.ok(root.classes.has('jp-no-tooltip'));
    await tabs(root)[1].click();
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
test('bare link shortening retains the exact target and accessible address without adding a hover title', () => {
  const view = Object.create(JournalCaptureView.prototype); const bubble = new Element();
  const url = 'https://www.example.com/path?q=memo#section';
  const bare = bubble.createEl('a', { text: url, attr: { href: url } });
  const authored = bubble.createEl('a', { text: 'My link label', attr: { href: url, title: 'User-authored title' } });
  const local = bubble.createEl('a', { text: 'A note', attr: { href: 'obsidian://open?vault=MindCraft' } });
  view.shortenBareLinks(bubble);
  assert.equal(bare.textContent, 'example.com'); assert.ok(bare.classes.has('jp-short-link'));
  assert.equal(bare.getAttribute('href'), url); assert.equal(bare.getAttribute('aria-label'), url);
  assert.equal(bare.getAttribute('title'), undefined);
  assert.equal(authored.getAttribute('title'), 'User-authored title'); assert.equal(authored.textContent, 'My link label');
  assert.equal(local.getAttribute('href'), 'obsidian://open?vault=MindCraft');
});
test('all plugin-owned modal shells including fuzzy pickers opt into the scoped tooltip policy', () => {
  const { ImageMetadataConfirmModal, DeleteConfirmModal, TagRenameModal, TagPickerModal,
    TagDeleteConfirmModal, ImagePreviewModal, SendToMyClaudianModal, FolderSuggestModal } = loaded.exports;
  const moment = require('moment');
  const stub = obsidian.moment;
  try {
    obsidian.moment = moment;
    const modals = [
      new ImageMetadataConfirmModal({}, { capturedAt: null, location: null }, () => {}),
      new DeleteConfirmModal({}, { title: 'Delete memo', audioPaths: [], mode: 'memo', onConfirm() {} }),
      new TagRenameModal({}, 'tag', () => {}), new TagPickerModal({}, ['one', 'two'], 'move', () => {}),
      new TagDeleteConfirmModal({}, { tag: 'tag', hasChildren: false, ownCount: 1, totalCount: 1, onConfirm() {} }),
      new CalendarPickerModal({}, moment('2026-01-01'), async () => new Set(), () => {}),
      new ImagePreviewModal({}, 'blob:preview', 'A photo'),
      new SendToMyClaudianModal({}, { text: 'Memo text', date: '2026-01-01', timestamp: '12:00', notePath: null }),
      new FolderSuggestModal({}, ['/', 'Photos'], () => {}),
    ];
    for (const modal of modals) assert.ok(modal.modalEl.classes.has('jp-no-tooltip'), modal.constructor.name);
  } finally { obsidian.moment = stub; }
});
test('capture shell alone opts into the scoped policy when opened', async () => {
  const view = Object.create(JournalCaptureView.prototype);
  view.containerEl = new Element(); view.containerEl.createDiv(); const root = view.containerEl.createDiv();
  const otherPlugin = new Element();
  view.app = { vault: { on() {} } }; view.registerEvent = () => {};
  view.plugin = { settings: { captureZenMode: false } }; view.zenBtn = new Element('button');
  view.registerDomEvent = () => {};
  for (const name of ['setupCapturePlaceholder', 'buildZenExitButton', 'setupZenBackdrop', 'buildTabBar', 'buildInputCard', 'buildTimeline', 'setupIntersectionObserver', 'setupMobileToolbarAutoHide', 'loadTagIndex']) view[name] = () => {};
  view.fullRebuild = async () => {};
  await view.onOpen();
  assert.ok(root.classes.has('jp-capture-root')); assert.ok(root.classes.has('jp-no-tooltip'));
  assert.ok(!view.containerEl.classes.has('jp-no-tooltip')); assert.ok(!otherPlugin.classes.has('jp-no-tooltip'));
});
test('only Spark Memo ribbon icon receives the scoped suppression marker and keeps its action/name', async () => {
  setup();
  const cleanups = [], icon = new Element();
  const plugin = new SparkMemoPlugin({ vault: { configDir: '.obsidian', adapter: { exists: async () => false } } });
  plugin.manifest = { id: 'spark-memo', dir: '.obsidian/plugins/spark-memo' };
  plugin.register = fn => cleanups.push(fn);
  plugin.loadSettings = async () => {}; plugin.applyCSSVariables = () => {};
  plugin.registerEditorExtension = () => {}; plugin.createEditorExtensions = () => [];
  plugin.registerMarkdownPostProcessor = () => {}; plugin.addSettingTab = () => {};
  plugin.registerView = () => {}; plugin.addCommand = () => {};
  let clicked = false; plugin.activateCaptureView = () => { clicked = true; };
  plugin.addRibbonIcon = (name, label, action) => { icon.setAttribute('aria-label', label); icon.action = action; return icon; };
  try {
    await plugin.onload();
    assert.ok(icon.classes.has('jp-no-tooltip')); assert.equal(icon.getAttribute('aria-label'), 'Spark Memo');
    icon.action(); assert.ok(clicked);
  } finally { cleanups.forEach(fn => fn()); }
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
    assert.equal(root.querySelectorAll('.jp-settings-about-btn').length, 3);
  }
});

test('random memo heading shares the search dice glyph without adding another random action', async () => {
  const moment = require('moment');
  for (const locale of ['zh', 'zh-TW', 'en', 'ja']) {
    setup(); setLanguage(locale);
    const view = Object.create(JournalCaptureView.prototype);
    view.randomMemoBtn = new Element('button'); view.searchInputEl = { value: '' }; view.updateSearchActionBtn();
    const day = { date: moment('2024-12-09'), el: new Element(), filePath: 'daily/2024-12-09.md', scope: {} };
    const entry = { timestamp: '14:46', text: 'Memo text', lineIndex: 1 };
    view.renderEntryBody = async (text, bubble) => { bubble.setText(text); };
    for (const method of ['applyImageGrid', 'attachImagePreviews', 'renderFileEmbedCards', 'attachTagClickHandlers']) view[method] = () => {};
    const actions = []; view.currentTab = 'search'; view.switchTab = tab => actions.push(tab);
    view.renderRandomMemoContent(day, entry); await Promise.resolve();
    const header = day.el.children[0]; const marker = header.children[0];
    assert.ok(marker.classes.has('jp-timeline-dot--header')); assert.ok(marker.classes.has('jp-timeline-dot--random'));
    assert.equal(marker.icon, 'dice'); assert.equal(marker.icon, view.randomMemoBtn.icon);
    assert.equal(marker.tagName, 'div'); assert.equal(marker.getAttribute('aria-hidden'), 'true');
    assert.equal(marker.getAttribute('title'), undefined); assert.equal(marker.listeners.click, undefined);
    assert.equal(day.el.querySelector('.jp-timeline-header-title').textContent, t('search.randomMemoLabel'));
    const ordinaryDot = day.el.children[1].children[0];
    assert.ok(ordinaryDot.classes.has('jp-timeline-dot')); assert.ok(!ordinaryDot.classes.has('jp-timeline-dot--random'));
    assert.equal(ordinaryDot.icon, undefined);
    const buttons = day.el.querySelectorAll('button'); assert.equal(buttons.length, 1);
    assert.equal(buttons[0].icon, 'crosshair'); await buttons[0].click();
    assert.deepEqual(actions, ['capture']); assert.equal(view.currentDate.format('YYYY-MM-DD'), '2024-12-09');
    view.searchInputEl.value = 'find'; view.updateSearchActionBtn();
    assert.equal(view.randomMemoBtn.icon, 'x'); assert.equal(marker.icon, 'dice');
    assert.equal(view.randomMemoBtn.getAttribute('aria-label'), t('search.clearQuery'));
  }
});
test('random heading dice keeps the existing header anchor and matches search icon size with mobile-safe SVG sizing', () => {
  const css = require('node:fs').readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = css.match(new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]+)\\}'));
    assert.ok(found, selector); return found[1];
  };
  const marker = rule('.jp-timeline-dot--random');
  assert.match(marker, /color:\s*var\(--jp-tl-dot\)/);
  assert.match(marker, /border:\s*0\s*;/); assert.match(marker, /box-shadow:\s*none\s*;/);
  assert.ok(!/\b(?:left|top|width|height):/.test(marker)); // Inherit the unchanged header-dot anchor.
  const svg = rule('.jp-timeline-dot--random svg');
  const search = rule('.jp-search-bar-random-btn svg');
  for (const property of ['width', 'height']) {
    const pattern = new RegExp('(?:^|\\n)\\s*' + property + ':\\s*([^;]+);');
    assert.equal(svg.match(pattern)[1], search.match(pattern)[1]);
  }
  assert.match(svg, /flex:\s*0 0 auto\s*;/);
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


// Real composer construction and shared write path under DOM doubles.
// These establish behavior, not actual Obsidian keyboard dispatch or visual acceptance.
function composer({ mac = true, mobile = false, ios = false, language = 'en' } = {}) {
  setup(); setLanguage(language);
  Object.assign(obsidian.Platform, { isMacOS: mac, isMobile: mobile, isIosApp: ios });
  const previousMoment = obsidian.moment; obsidian.moment = require('moment');
  const view = new JournalCaptureView({}, { settings: { ...DEFAULT_SETTINGS } });
  obsidian.moment = previousMoment;
  view.app = { scope: { sentinel: 'host-scope' }, metadataCache: { on() {} }, vault: { on() {} } };
  view.registerEvent = () => {}; view.registerDomEvent = () => {};
  for (const name of ['renderCaptureTimePill', 'renderLocationPill', 'renderMetadataHintPill', 'renderEditingPill', 'renderAttachmentList', 'autoResizeTextarea']) view[name] = () => {};
  const root = new Element();
  view.containerEl = new Element(); view.containerEl.createDiv(); view.containerEl.children.push(root);
  view.buildInputCard(root);
  return { view, root };
}
function keyEvent(view, overrides = {}) {
  return {
    target: view.textareaEl, key: 'Enter', metaKey: obsidian.Platform.isMacOS || obsidian.Platform.isIosApp,
    ctrlKey: !(obsidian.Platform.isMacOS || obsidian.Platform.isIosApp), shiftKey: false, altKey: false,
    repeat: false, isComposing: false, keyCode: 13, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
    ...overrides,
  };
}
function textareaKey(view, overrides) {
  const event = keyEvent(view, overrides);
  view.textareaEl.listeners.keydown.forEach(fn => fn(event));
  return event;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function readyToWrite(view) {
  const moment = require('moment'); obsidian.moment = moment;
  view.textareaEl.value = 'A memo'; view.days = [{ date: moment() }];
  view.fullRebuild = async () => {};
  view.refreshSubmitState();
}
test('composer keycaps follow OS rather than language, hide on mobile, and preserve localized accessibility', () => {
  for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
    for (const mac of [true, false]) {
      const { view, root } = composer({ mac, language });
      const hint = root.querySelector('kbd');
      assert.equal(hint.textContent, mac ? '⌘ ↵' : 'Ctrl ↵');
      assert.equal(hint.getAttribute('aria-hidden'), 'true'); assert.equal(hint.getAttribute('title'), undefined);
      assert.equal(hint.listeners.click, undefined);
      assert.equal(view.submitBtn.getAttribute('aria-label'), t('capture.submit'));
      assert.equal(view.submitBtn.getAttribute('aria-keyshortcuts'), mac ? 'Meta+Enter' : 'Control+Enter');
      const group = root.querySelector('.jp-capture-submit-group');
      assert.equal(group.children[0], hint); assert.equal(group.children[1], view.submitBtn);
      assert.equal(view.submitBtn.icon, 'arrow-up'); assert.equal(view.submitBtn.disabled, true);
    }
  }
  for (const ios of [true, false]) {
    const { root, view } = composer({ mac: false, mobile: true, ios });
    assert.equal(root.querySelector('kbd'), null);
    assert.equal(view.submitBtn.getAttribute('aria-keyshortcuts'), ios ? 'Meta+Enter' : 'Control+Enter');
  }
});
test('exact platform chord saves only in composer, including scoped host interception and textarea fallback', () => {
  for (const mac of [true, false]) {
    const { view } = composer({ mac }); let saves = 0;
    view.handleSubmit = async () => { saves++; };
    const [binding] = view.scope.bindings;
    assert.equal(view.scope.parent, view.app.scope); assert.deepEqual(plain(binding.modifiers), ['Mod']); assert.equal(binding.key, 'Enter');
    const event = keyEvent(view);
    assert.equal(binding.callback(event), false); assert.equal(saves, 1);
    assert.ok(event.defaultPrevented); assert.ok(event.stopped);
    // If a host still dispatches the consumed event, the fallback cannot save twice.
    view.textareaEl.listeners.keydown.forEach(fn => fn(event)); assert.equal(saves, 1);
    textareaKey(view); assert.equal(saves, 2);
    for (const overrides of [
      { target: new Element('textarea') }, { key: 's' }, { metaKey: false, ctrlKey: false },
      { metaKey: !mac, ctrlKey: mac }, { shiftKey: true }, { altKey: true }, { metaKey: true, ctrlKey: true },
    ]) assert.equal(binding.callback(keyEvent(view, overrides)), undefined);
    assert.equal(saves, 2);
    view.currentTab = 'search'; assert.equal(binding.callback(keyEvent(view)), undefined); assert.equal(saves, 2);
  }
});
test('ordinary Enter keeps newline or suggestion confirmation; save chord never selects a suggestion', () => {
  const { view } = composer(); let saves = 0, tag = 0, mention = 0;
  view.handleSubmit = async () => { saves++; };
  assert.equal(textareaKey(view, { metaKey: false }).defaultPrevented, false); assert.equal(saves, 0);
  view.selectTagSuggestion = () => { tag++; };
  view.selectMentionSuggestion = () => { mention++; };
  view.tagSuggestRange = { start: 0, end: 2 }; view.tagSuggestMatches = ['#tag'];
  textareaKey(view); assert.equal(saves, 1); assert.equal(tag, 0);
  textareaKey(view, { metaKey: false }); textareaKey(view, { metaKey: false, key: 'Tab' }); assert.equal(tag, 2);
  view.mentionSuggestRange = { start: 0, end: 2 }; view.mentionSuggestMatches = [{}];
  textareaKey(view); assert.equal(saves, 2); assert.equal(mention, 0);
  textareaKey(view, { metaKey: false }); textareaKey(view, { metaKey: false, key: 'Tab' }); assert.equal(mention, 2);
});
test('composition and long-press never submit or accidentally select a suggestion', () => {
  const { view } = composer(); let saves = 0, selected = 0;
  view.handleSubmit = async () => { saves++; };
  view.mentionSuggestRange = { start: 0, end: 2 }; view.mentionSuggestMatches = [{}];
  view.selectMentionSuggestion = () => { selected++; };
  for (const override of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal(view.scope.bindings[0].callback(keyEvent(view, override)), undefined);
    textareaKey(view, override); textareaKey(view, { ...override, metaKey: false });
  }
  view.textareaEl.listeners.compositionstart[0]();
  textareaKey(view); textareaKey(view, { metaKey: false }); assert.equal(saves, 0); assert.equal(selected, 0);
  view.textareaEl.listeners.compositionend[0]();
  assert.ok(textareaKey(view, { repeat: true }).defaultPrevented); assert.equal(saves, 0);
  textareaKey(view); assert.equal(saves, 1); assert.equal(selected, 0);
});
test('shared submit rejects empty, recording and composition states without writes', async () => {
  const { view } = composer(); let writes = 0;
  view.plugin.writeJournalEntry = async () => { writes++; return false; };
  await view.handleSubmit(); textareaKey(view); await settle(); assert.equal(writes, 0);
  view.textareaEl.value = 'A draft'; view.recordingBusy = true; view.refreshSubmitState();
  assert.equal(view.submitBtn.disabled, true); textareaKey(view); await view.handleSubmit(); assert.equal(writes, 0);
  view.recordingBusy = false; view.inputComposing = true; await view.handleSubmit(); assert.equal(writes, 0);
  view.inputComposing = false; view.refreshSubmitState(); assert.equal(view.submitBtn.disabled, false);
});
test('keyboard and click share a single write lock, even when input refreshes during saving', async () => {
  const { view } = composer(); const previousMoment = obsidian.moment;
  try {
    readyToWrite(view); const write = deferred(); let calls = 0;
    view.plugin.writeJournalEntry = async () => { calls++; return write.promise; };
    textareaKey(view); assert.equal(calls, 1); assert.equal(view.isSubmitting, true);
    assert.equal(view.submitBtn.disabled, true); assert.equal(view.submitBtn.icon, 'loader-2');
    view.refreshSubmitState(); assert.equal(view.submitBtn.disabled, true);
    textareaKey(view); await view.submitBtn.click(); await view.handleSubmit(); assert.equal(calls, 1);
    write.resolve(true); await settle();
    assert.equal(view.isSubmitting, false); assert.equal(view.textareaEl.value, '');
    assert.equal(view.submitBtn.disabled, true); assert.equal(view.submitBtn.icon, 'arrow-up');
  } finally { obsidian.moment = previousMoment; }
});
test('failed writes release the lock and keep the draft available for retry', async () => {
  for (const throws of [false, true]) {
    const { view } = composer(); const previousMoment = obsidian.moment;
    try {
      readyToWrite(view); let calls = 0;
      view.plugin.writeJournalEntry = async () => { calls++; if (throws) throw Error('Expected test failure'); return false; };
      await view.handleSubmit();
      assert.equal(calls, 1); assert.equal(view.textareaEl.value, 'A memo');
      assert.equal(view.isSubmitting, false); assert.equal(view.submitBtn.disabled, false); assert.equal(view.submitBtn.icon, 'arrow-up');
      await view.handleSubmit(); assert.equal(calls, 2);
    } finally { obsidian.moment = previousMoment; }
  }
});
test('shortcut reuses editing and attachment-only save paths without appending duplicate new memos', async () => {
  const { view } = composer(); const previousMoment = obsidian.moment;
  try {
    readyToWrite(view); view.editingEntry = { sentinel: 'existing memo' };
    let appended = 0, edited = 0;
    view.plugin.writeJournalEntry = async () => { appended++; return false; };
    view.updateEditedEntry = async raw => { edited++; assert.equal(raw, 'A memo'); return true; };
    textareaKey(view); await settle(); assert.equal(edited, 1); assert.equal(appended, 0); assert.equal(view.editingEntry, null);
    for (const kind of ['pendingImages', 'pendingAudio', 'pendingFiles']) {
      const file = { path: 'Attachments/item' };
      view[kind] = kind === 'pendingAudio' ? [{ file, duration: '00:01' }] : [file];
      view.textareaEl.value = ''; view.refreshSubmitState(); assert.equal(view.submitBtn.disabled, false);
      textareaKey(view); await settle(); assert.equal(appended, 1);
      appended = 0; view[kind] = [];
    }
  } finally { obsidian.moment = previousMoment; }
});
test('microphone permission and recording finalization block saving until the audio attachment is ready', async () => {
  const { view } = composer(); view.textareaEl.value = 'Recording draft';
  const previous = runtimeNavigator.mediaDevices.getUserMedia;
  try {
    const permission = deferred(); runtimeNavigator.mediaDevices.getUserMedia = () => permission.promise;
    const starting = view.startRecordingFn(); assert.equal(view.recordingBusy, true); assert.equal(view.submitBtn.disabled, true);
    let writes = 0; view.plugin.writeJournalEntry = async () => { writes++; return false; };
    textareaKey(view); await settle(); assert.equal(writes, 0);
    permission.resolve({ getTracks: () => [] }); await starting;
    assert.equal(view.recordingBusy, true);
    const audio = deferred(); view.saveAudioToVault = () => audio.promise;
    view.addPendingAudio = file => view.pendingAudio.push({ file, duration: '00:01' });
    const stopping = TestMediaRecorder.latest.onstop();
    textareaKey(view); await settle(); assert.equal(writes, 0); assert.equal(view.recordingBusy, true);
    audio.resolve({ path: 'Audio/recording.webm' }); await stopping;
    assert.equal(view.recordingBusy, false); assert.equal(view.pendingAudio.length, 1); assert.equal(view.submitBtn.disabled, false);
  } finally { runtimeNavigator.mediaDevices.getUserMedia = previous; }
});
test('microphone permission failure restores save availability', async () => {
  const { view } = composer(); view.textareaEl.value = 'Draft';
  await view.startRecordingFn();
  assert.equal(view.recordingBusy, false); assert.equal(view.submitBtn.disabled, false); assert.equal(view.textareaEl.value, 'Draft');
});
test('shortcut hint is hover-only across the entire input card and retains its layout slot', () => {
  const css = require('node:fs').readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.jp-capture-submit-shortcut\s*\{\s*display:\s*inline-block;\s*opacity:\s*0;/);
  assert.match(css, /\.jp-capture-card:hover \.jp-capture-submit-shortcut\s*\{\s*opacity:\s*1;/);
  assert.doesNotMatch(css, /:focus(?:-within|-visible)?[^{}]*\.jp-capture-submit-shortcut/);
});

test('keycap styling is local, non-interactive, responsive and disappears with recording controls', () => {
  const css = require('node:fs').readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.jp-capture-actions\s*\{[^}]*container-name:\s*jp-composer-actions/s);
  assert.match(css, /@container jp-composer-actions \(max-width: 260px\)\s*\{\s*\.jp-capture-submit-shortcut\s*\{\s*display:\s*none/s);
  assert.match(css, /\.jp-capture-submit-shortcut\s*\{[^}]*background:\s*var\(--background-secondary\)[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.jp-capture-actions\.is-recording \.jp-capture-submit-group\s*\{\s*display:\s*none/s);
});



test('every random prompt is translated in all four languages and preserves the 10/8 pools', () => {
  const inputKeys = JournalCaptureView.INPUT_PLACEHOLDERS;
  const locationKeys = JournalCaptureView.LOCATION_EMPTY_PLACEHOLDERS;
  assert.equal(inputKeys.length, 10); assert.equal(locationKeys.length, 8);
  assert.equal(new Set(inputKeys).size, 10); assert.equal(new Set(locationKeys).size, 8);
  const english = new Map(); setLanguage('en');
  assert.deepEqual(plain(inputKeys.map(key => t(key))), [
    "What's happening?", "What's on your mind?", "What's going on?", 'Got something to jot down?',
    'What just happened?', 'Anything worth remembering?', 'What are you up to?', 'Say something.',
    "What's new?", 'Write it down before it slips away.',
  ]);
  assert.deepEqual(plain(locationKeys.map(key => t(key))), [
    'No footprints on the map yet.', 'Not a single place has found you yet.', 'The map is still blank — for now.',
    'Somewhere, someday. Just not yet.', 'Your atlas is waiting to be written.', 'No dots on the map. No stories to tell.',
    "The world hasn't left a mark here yet.", 'Still waiting for your first coordinate.',
  ]);
  for (const key of [...inputKeys, ...locationKeys]) english.set(key, t(key));
  const originalRandom = runtimeMath.random;
  try {
    for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
      const { view } = composer({ language });
      for (const [keys, picker] of [[inputKeys, 'pickRandomPlaceholder'], [locationKeys, 'pickRandomLocationEmptyPlaceholder']]) {
        for (let i = 0; i < keys.length; i++) {
          runtimeMath.random = () => (i + 0.5) / keys.length;
          const text = view[picker](); assert.equal(text, t(keys[i])); assert.notEqual(text, keys[i]);
          if (language !== 'en') assert.notEqual(text, english.get(keys[i]), `${language}:${keys[i]}`);
        }
      }
    }
    setLanguage('zh'); assert.equal(t(inputKeys[4]), '刚刚发生了什么？'); assert.equal(t('search.randomMemoLabel'), '随机 Memo');
    setLanguage('zh-TW'); assert.equal(t(inputKeys[4]), '剛剛發生了什麼？');
    setLanguage('ja'); assert.equal(t(inputKeys[4]), '今、何がありましたか？');
    setLanguage('en'); assert.equal(t(inputKeys[4]), 'What just happened?');
  } finally { runtimeMath.random = originalRandom; }
});
test('creation, successful save and edit cancellation select prompts in the current plugin language', async () => {
  const originalRandom = runtimeMath.random, previousMoment = obsidian.moment;
  try {
    for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
      runtimeMath.random = () => 0;
      const { view } = composer({ language });
      assert.equal(view.textareaEl.getAttribute('placeholder'), t(JournalCaptureView.INPUT_PLACEHOLDERS[0]));
      readyToWrite(view); view.plugin.writeJournalEntry = async () => true;
      runtimeMath.random = () => 0.45;
      await view.handleSubmit(); assert.equal(view.textareaEl.placeholder, t(JournalCaptureView.INPUT_PLACEHOLDERS[4]));
      view.editingEntry = { sentinel: 'edit' }; view.textareaEl.value = 'Edited memo';
      view.updateEditedEntry = async () => true; runtimeMath.random = () => 0.65;
      await view.handleSubmit(); assert.equal(view.textareaEl.placeholder, t(JournalCaptureView.INPUT_PLACEHOLDERS[6]));
      view.editingEntry = { sentinel: 'edit' }; view.textareaEl.value = 'Draft';
      runtimeMath.random = () => 0.95; view.cancelEdit();
      assert.equal(view.textareaEl.placeholder, t(JournalCaptureView.INPUT_PLACEHOLDERS[9]));
      assert.equal(view.textareaEl.value, ''); assert.equal(view.editingEntry, null);
    }
  } finally { runtimeMath.random = originalRandom; obsidian.moment = previousMoment; }
});
test('empty location list uses localized random messages without lookup requests', () => {
  const originalRandom = runtimeMath.random;
  try {
    for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
      const { view } = composer({ language });
      view.timelineEl = new Element(); view.locationTitleEl = new Element(); view.locationIndex = new Map();
      for (let i = 0; i < 8; i++) {
        runtimeMath.random = () => (i + 0.5) / 8; view.renderLocationList();
        assert.equal(view.timelineEl.querySelector('.jp-capture-empty').textContent, t(JournalCaptureView.LOCATION_EMPTY_PLACEHOLDERS[i]));
        assert.equal(view.locationIndex.size, 0);
      }
    }
  } finally { runtimeMath.random = originalRandom; }
});
test('language changes affect the next prompt pick without clearing draft, attachments or edit state', () => {
  const originalRandom = runtimeMath.random;
  try {
    runtimeMath.random = () => 0.45;
    const { view } = composer({ language: 'en' });
    view.textareaEl.value = 'User content stays unchanged';
    const image = { path: '照片/photo.png' }, edit = { sentinel: 'editing' };
    view.pendingImages = [image]; view.editingEntry = edit;
    setLanguage('ja');
    assert.equal(view.pickRandomPlaceholder(), t(JournalCaptureView.INPUT_PLACEHOLDERS[4]));
    assert.equal(view.textareaEl.value, 'User content stays unchanged'); assert.equal(view.pendingImages[0], image); assert.equal(view.editingEntry, edit);
  } finally { runtimeMath.random = originalRandom; }
});
test('random prompts follow Obsidian aliases when no manual plugin language is selected', () => {
  const originalRandom = runtimeMath.random;
  try {
    const { view } = composer(); runtimeMath.random = () => 0.45;
    setLanguage('system');
    for (const [host, expected] of [['zh-CN', '刚刚发生了什么？'], ['zh-Hant-HK', '剛剛發生了什麼？'], ['ja-JP', '今、何がありましたか？'], ['fr', 'What just happened?']]) {
      hostLanguage = host; assert.equal(view.pickRandomPlaceholder(), expected);
    }
  } finally { runtimeMath.random = originalRandom; }
});
test('image preview failures use localized explanations and preserve external error details', async () => {
  const { ImagePreviewModal } = loaded.exports;
  try {
    for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
      setLanguage(language); const modal = new ImagePreviewModal({}, 'blob:test');
      previewDecodeFails = true;
      await assert.rejects(modal.toPng(new Blob(['image'])), error => error.message === t('preview.errorDecodeFailed'));
      previewDecodeFails = false; previewCanvas = { getContext: () => null };
      await assert.rejects(modal.toPng(new Blob(['image'])), error => error.message === t('preview.errorCanvasUnavailable'));
      previewCanvas = { getContext: () => ({ drawImage() {} }), toBlob: fn => fn(null) };
      await assert.rejects(modal.toPng(new Blob(['image'])), error => error.message === t('preview.errorEncodeFailed'));
      notices.length = 0; await modal.copyCurrentImageLink();
      assert.ok(notices.at(-1).includes(t('preview.errorNoVaultPath'))); assert.ok(!notices.at(-1).includes('no vault path'));
      modal.currentBlob = async () => { throw 'EXTERNAL_IMAGE_FAILURE_421'; };
      await modal.copyCurrentImage();
      assert.ok(notices.at(-1).includes('EXTERNAL_IMAGE_FAILURE_421'));
      assert.ok(notices.at(-1).includes(t('notice.imageCopyFailed', { error: 'EXTERNAL_IMAGE_FAILURE_421' }).replace(/^❌\s*/, '')));
    }
  } finally { previewDecodeFails = false; previewCanvas = null; }
});
test('Craftian exceptions include a translated operation message and retain the original external detail', async () => {
  const { SendToMyClaudianModal } = loaded.exports;
  for (const language of ['zh', 'zh-TW', 'en', 'ja']) {
    setLanguage(language); notices.length = 0;
    const modal = new SendToMyClaudianModal({}, { text: '原始 Memo', date: '2026-01-01', timestamp: '12:00', notePath: null });
    modal.app = { plugins: { plugins: { myclaudian: { async sendFromPlugin() { throw 'EXTERNAL_CRAFTIAN_FAILURE_422'; } } } } };
    modal.inputEl = new Element('textarea'); modal.sendBtn = new Element('button');
    await modal.send('指令正文不改');
    assert.ok(notices.at(-1).includes(t('myclaudian.sendError', { error: 'EXTERNAL_CRAFTIAN_FAILURE_422' }).replace(/^❌\s*/, '')));
    assert.ok(notices.at(-1).includes('EXTERNAL_CRAFTIAN_FAILURE_422'));
    assert.equal(modal.sendBtn.disabled, false); assert.equal(modal.sendBtn.textContent, t('myclaudian.send'));
  }
});


// Zen behavior uses the real composer/save handlers; no user-vault writes.
test('desktop Zen toggle sits directly after mention, preserves draft and attachments, and persists both choices', async () => {
  for (const mac of [true, false]) {
    const { view, root } = composer({ mac });
    const saved = [];
    view.plugin.saveSettings = async () => saved.push(view.plugin.settings.captureZenMode);
    const row = root.querySelector('.jp-capture-button-row');
    const mention = row.children.findIndex(child => child.classes.has('jp-capture-mention-btn'));
    assert.equal(row.children[mention + 1], view.zenBtn);
    assert.equal(view.zenBtn.getAttribute('title'), undefined);
    assert.equal(view.zenBtn.getAttribute('aria-label'), t('capture.enterZen'));
    assert.equal(view.zenBtn.icon, 'maximize');
    view.setToolbarHidden = () => {};
    view.textareaEl.value = 'Keep this draft'; view.textareaEl.selectionStart = 4;
    const image = { path: 'test.jpg' }; view.pendingImages = [image];
    await view.zenBtn.click(); await view.zenSaveQueue;
    assert.equal(view.zenMode, true); assert.equal(root.classes.has('jp-capture-zen'), true);
    assert.equal(view.zenBtn.getAttribute('aria-pressed'), 'true'); assert.equal(view.zenBtn.icon, 'minimize');
    assert.equal(view.textareaEl.value, 'Keep this draft'); assert.equal(view.textareaEl.selectionStart, 4);
    assert.equal(view.pendingImages[0], image); assert.equal(focused, view.textareaEl);
    await view.zenBtn.click(); await view.zenSaveQueue;
    assert.equal(view.zenMode, false); assert.equal(root.classes.has('jp-capture-zen'), false);
    assert.equal(view.zenBtn.getAttribute('aria-pressed'), 'false'); assert.equal(view.zenBtn.icon, 'maximize');
    assert.deepEqual(saved, [true, false]); assert.equal(view.pendingImages[0], image);
  }
});

test('remembered Zen state restores before initial timeline render and performs no startup save', async () => {
  for (const mobile of [false, true]) for (const enabled of [true, false]) {
    const expected = enabled && !mobile;
    const view = Object.create(JournalCaptureView.prototype);
    view.containerEl = new Element(); view.containerEl.createDiv(); const root = view.containerEl.createDiv();
    view.plugin = { settings: { captureZenMode: enabled }, saveSettings() { assert.fail('Startup must not save'); } };
    view.app = { vault: { on() {} } }; view.registerEvent = () => {}; view.registerDomEvent = () => {};
    for (const name of ['setupCapturePlaceholder', 'buildZenExitButton', 'setupZenBackdrop', 'buildTabBar', 'buildTimeline', 'setupIntersectionObserver', 'setupMobileToolbarAutoHide', 'loadTagIndex']) view[name] = () => {};
    view.buildInputCard = () => { view.zenBtn = mobile ? null : new Element('button'); };
    view.fullRebuild = async () => { assert.equal(root.classes.has('jp-capture-zen'), expected); };
    obsidian.Platform.isMobile = mobile;
    await view.onOpen(); assert.equal(view.zenMode, expected);
    assert.equal(view.plugin.settings.captureZenMode, enabled);
  }
  obsidian.Platform.isMobile = false;
});

test('phones and tablets have no Zen button, ignore synced Zen and never reset the desktop preference', async () => {
  for (const ios of [false, true]) for (const saved of [false, true]) {
    const { view, root } = composer({ mobile: true, ios });
    view.plugin.settings.captureZenMode = saved;
    view.plugin.saveSettings = async () => assert.fail('Mobile must not persist Zen');
    view.textareaEl.value = 'Mobile draft';
    const image = { path: 'mobile.jpg' }; view.pendingImages = [image];
    assert.equal(view.zenBtn, null);
    assert.equal(root.querySelectorAll('.jp-capture-zen-btn').length, 0);
    const row = root.querySelector('.jp-capture-button-row');
    assert.deepEqual(row.children.map(child => child.getAttribute('aria-label')), [
      t('capture.add'), t('capture.addTag'), t('capture.addMention'), t('capture.addLocation'),
    ]);
    assert.equal(row.children[3], view.geoBtnEl); assert.equal(view.geoBtnEl.icon, 'map-pin');
    assert.equal(root.querySelectorAll('.jp-capture-submit-shortcut').length, 0);
    view.applyZenMode(true); view.toggleZenMode(); await view.zenSaveQueue;
    assert.equal(view.zenMode, false); assert.equal(root.classes.has('jp-capture-zen'), false);
    assert.equal(view.plugin.settings.captureZenMode, saved);
    const escape = keyEvent(view, { key: 'Escape', keyCode: 27, metaKey: false, ctrlKey: false });
    assert.equal(view.handleZenEscape(escape), false); assert.equal(escape.defaultPrevented, false);
    assert.equal(view.textareaEl.value, 'Mobile draft'); assert.equal(view.pendingImages[0], image);
  }
});

test('Zen setting defaults off and survives the real settings save/load path', async () => {
  assert.equal(DEFAULT_SETTINGS.captureZenMode, false);
  for (const enabled of [true, false, undefined]) {
    const plugin = new SparkMemoPlugin({ workspace: { iterateAllLeaves() {} } });
    const stored = enabled === undefined ? { targetHeading: 'Custom' } : { targetHeading: 'Custom', captureZenMode: enabled };
    plugin.loadData = async () => plain(stored);
    await plugin.loadSettings(); assert.equal(plugin.settings.captureZenMode, enabled === true);
    assert.equal(plugin.settings.targetHeading, 'Custom');
    plugin.applyCSSVariables = () => {}; let disk;
    plugin.saveData = async value => { disk = plain(value); };
    plugin.settings.captureZenMode = !plugin.settings.captureZenMode;
    await plugin.saveSettings();
    plugin.loadData = async () => disk;
    await plugin.loadSettings(); assert.equal(plugin.settings.captureZenMode, enabled !== true);
  }
});

test('Zen Escape dismisses suggestions first, does not reopen on keyup, then exits and remembers', async () => {
  for (const popup of ['mention', 'tag']) {
    const { view } = composer(); view.plugin.saveSettings = async () => {};
    view.applyZenMode(true);
    view[popup + 'SuggestRange'] = { start: 0, end: 1 };
    const first = textareaKey(view, { key: 'Escape', keyCode: 27, metaKey: false, ctrlKey: false });
    assert.equal(first.defaultPrevented, true); assert.equal(view.zenMode, true);
    assert.equal(view[popup + 'SuggestRange'], null);
    let reopened = 0;
    view.updateMentionSuggestions = view.updateTagSuggestions = () => reopened++;
    view.textareaEl.listeners.keyup.forEach(fn => fn({ key: 'Escape' })); assert.equal(reopened, 0);
    textareaKey(view, { key: 'Escape', keyCode: 27, metaKey: false, ctrlKey: false });
    await view.zenSaveQueue;
    assert.equal(view.zenMode, false); assert.equal(view.plugin.settings.captureZenMode, false);
  }
});

test('scoped Zen Escape never intercepts IME, repeated keys, modifier keys, other panes or ordinary mode', async () => {
  const { view } = composer(); view.plugin.saveSettings = async () => {}; view.applyZenMode(true);
  const escape = { key: 'Escape', keyCode: 27, metaKey: false, ctrlKey: false };
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { metaKey: true },
    { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }, { target: new Element() }]) {
    assert.equal(view.handleZenEscape(keyEvent(view, { ...escape, ...extra })), false);
    assert.equal(view.zenMode, true);
  }
  view.inputComposing = true; assert.equal(view.handleZenEscape(keyEvent(view, escape)), false); view.inputComposing = false;
  const binding = view.scope.bindings.find(binding => binding.key === 'Escape');
  assert.deepEqual(plain(binding.modifiers), []);
  const buttonEvent = keyEvent(view, { ...escape, target: view.zenBtn });
  assert.equal(binding.callback(buttonEvent), false); assert.equal(buttonEvent.defaultPrevented, true);
  await view.zenSaveQueue; assert.equal(view.zenMode, false);
  assert.equal(view.handleZenEscape(keyEvent(view, escape)), false);
});

test('Zen cannot navigate to hidden tabs but all normal tabs remain available after exit', () => {
  const { view } = composer(); view.applyZenMode(true);
  for (const tab of ['search', 'tag', 'location', 'stats']) view.switchTab(tab);
  assert.equal(view.currentTab, 'capture');
  view.applyZenMode(false);
  // The existing navigation tests cover real tab contents; this guard must be lifted.
  view.currentTab = 'search'; view.captureTabBtn = new Element(); view.searchTabBtn = new Element();
  view.statsTabBtn = new Element(); view.locationTabBtn = new Element(); view.tagAggTabBtn = new Element();
  for (const field of ['capturePaneEl', 'statsPaneEl', 'searchBarEl', 'locationBarEl', 'tagAggBarEl']) view[field] = new Element();
  view.fullRebuild = async () => {};
  view.switchTab('capture'); assert.equal(view.currentTab, 'capture');
});

test('Zen save and edit keep composer-only mode, clear content, retain focus and skip timeline highlighting', async () => {
  for (const edit of [false, true]) {
    const { view, root } = composer(); readyToWrite(view); view.applyZenMode(true);
    view.textareaEl.focus();
    let writes = 0;
    view.plugin.writeJournalEntry = async () => { writes++; return true; };
    if (edit) { view.editingEntry = {}; view.updateEditedEntry = async () => { writes++; return true; }; }
    await view.handleSubmit();
    assert.equal(writes, 1); assert.equal(view.textareaEl.value, ''); assert.equal(view.zenMode, true);
    assert.equal(root.classes.has('jp-capture-zen'), true); assert.equal(focused, view.textareaEl);
    assert.equal(view.pendingHighlight, null);
  }
});

test('Zen failed/backdated saves keep the correct draft/mode and never steal focus outside the composer', async () => {
  const { view, root } = composer(); readyToWrite(view); view.applyZenMode(true);
  view.plugin.writeJournalEntry = async () => false;
  await view.handleSubmit(); assert.equal(view.textareaEl.value, 'A memo'); assert.equal(view.zenMode, true);
  const outside = new Element(); outside.focus();
  const target = require('moment')().subtract(2, 'days');
  view.pendingCaptureOverride = { date: target, time: '08:42' };
  let rebuilds = 0; view.fullRebuild = async () => rebuilds++;
  view.plugin.writeJournalEntry = async () => true;
  await view.handleSubmit(); assert.equal(view.textareaEl.value, ''); assert.equal(rebuilds, 1);
  assert.equal(view.currentDate.format('YYYY-MM-DD'), target.format('YYYY-MM-DD'));
  assert.equal(root.classes.has('jp-capture-zen'), true); assert.equal(view.pendingHighlight, null);
  assert.equal(focused, outside);
});

test('rapid Zen toggles serialize writes, recover after persistence errors and retain final choice', async () => {
  const { view } = composer(); const gate = deferred(); const saved = [];
  view.plugin.saveSettings = async () => { const state = view.plugin.settings.captureZenMode; saved.push(state); if (saved.length === 1) await gate.promise; };
  view.toggleZenMode(); await settle(); view.toggleZenMode();
  assert.deepEqual(saved, [true]); gate.resolve(); await view.zenSaveQueue;
  assert.deepEqual(saved, [true, false]); assert.equal(view.plugin.settings.captureZenMode, false);
  view.plugin.saveSettings = async () => { throw Error('Test settings failure'); };
  view.toggleZenMode(); await view.zenSaveQueue; assert.ok(notices.at(-1).includes(t('capture.zenSaveFailed')));
  view.plugin.saveSettings = async () => saved.push(view.plugin.settings.captureZenMode);
  view.toggleZenMode(); await view.zenSaveQueue; assert.equal(saved.at(-1), false);
});

test('only Zen removes its fill and border in normal and hovered states', () => {
  const css = require('node:fs').readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const rule = rules.find(([, selectors, body]) => selectors.trim() === '.jp-capture-zen-btn,\n.jp-capture-zen-btn:hover');
  assert.ok(rule, 'Zen-only style override must cover normal and hover');
  assert.match(rule[2], /background:\s*transparent !important;/);
  assert.match(rule[2], /border:\s*none !important;/);
  // The original insertion tools still use their existing filled round buttons.
  const shared = rules.find(([, selectors, body]) => selectors.includes('.jp-capture-plus-btn,') && body.includes('background: color-mix'));
  assert.ok(shared); assert.match(shared[2], /border:\s*1px solid/);
});

test('only Zen centers the natural-size composer, with safe scrolling when it exceeds the pane', () => {
  const css = require('node:fs').readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const pane = rules.find(([, selector]) => selector.trim() === '.jp-capture-zen > .jp-pane-capture');
  const card = rules.find(([, selector]) => selector.trim() === '.jp-capture-zen > .jp-pane-capture > .jp-capture-card');
  assert.ok(pane); assert.ok(card);
  assert.match(pane[2], /overflow-y:\s*auto;/);
  assert.match(card[2], /flex-shrink:\s*0;/);
  assert.match(card[2], /margin-block:\s*auto;/);
  assert.doesNotMatch(pane[2] + card[2], /(?:^|;)\s*(?:width|height|font-size|position|transform)\s*:/);
});

test('desktop Zen styles scope hidden tabs/timeline and retain hover, keyboard, touch and recording rules', () => {
  const css = require('node:fs').readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
  assert.match(css, /\.jp-capture-zen-btn\s*\{\s*opacity:\s*0;\s*pointer-events:\s*none;/);
  assert.match(css, /\.jp-capture-card:hover \.jp-capture-zen-btn,/);
  assert.match(css, /\.jp-capture-zen-btn:focus-visible,/);
  assert.match(css, /\.jp-capture-zen \.jp-capture-zen-btn\s*\{/);
  assert.doesNotMatch(css, /\.is-mobile \.jp-capture-zen-btn/);
  assert.match(css, /@media \(hover: none\)/);
  assert.match(css, /\.jp-capture-zen > \.jp-tab-bar,\s*\.jp-capture-zen > \.jp-pane-capture > \.jp-timeline-scroll\s*\{\s*display:\s*none !important;/);
  assert.match(css, /\.jp-capture-geo-btn svg,\s*\.jp-capture-zen-btn svg\s*\{[^}]*width:\s*18px !important;[^}]*flex-shrink:\s*0 !important;/);
  assert.match(css, /\.jp-capture-zen \.jp-capture-actions\.is-recording \.jp-capture-button-row/);
});

test('Zen background shares in-flight reads and caches coordinates without rendering the Locations tab', async () => {
  const { view } = composer(); const gate = deferred(); let reads = 0; const painted = [];
  view.zenMode = true; view.zenBackdrop = { setLocations: data => painted.push(data) };
  view.collectZenLocations = () => { reads++; return gate.promise; };
  view.renderLocationMap = () => assert.fail('Background must not use interactive map renderer');
  const first = view.refreshZenBackdrop(); const second = view.refreshZenBackdrop();
  assert.equal(first, second); assert.equal(reads, 1);
  const coords = [{latitude:31, longitude:121}]; gate.resolve(coords); await first;
  await view.refreshZenBackdrop(); assert.equal(reads, 1); assert.equal(painted.length, 2);
  assert.equal(view.zenLocations, coords);
});
test('Zen background discards stale reads and ignores results after panel closes', async () => {
  const { view } = composer(); const gate = deferred(); let reads = 0; const painted = [];
  view.zenMode = true; view.zenBackdrop = { setLocations: data => painted.push(data) };
  view.collectZenLocations = () => ++reads === 1 ? gate.promise : Promise.resolve([{latitude:1,longitude:2}]);
  const first = view.refreshZenBackdrop(); view.zenMapRevision++; gate.resolve([{latitude:3,longitude:4}]);
  await first; if (view.zenLocationLoad) await view.zenLocationLoad;
  assert.equal(reads, 2); assert.equal(painted.length, 1); assert.equal(painted[0][0].latitude, 1);
  const closed = deferred(); view.zenLocations = null; view.collectZenLocations = () => closed.promise;
  const pending = view.refreshZenBackdrop(); view.zenClosed = true; closed.resolve([]); await pending;
  assert.equal(painted.length, 1);
});
test('mobile Zen never creates or refreshes a map background', async () => {
  const { view, root } = composer({mobile:true});
  view.setupZenBackdrop(root); assert.equal(view.zenBackdrop, null);
  view.collectZenLocations = () => assert.fail('Mobile must not scan locations');
  await view.refreshZenBackdrop(); view.invalidateZenBackdrop(); assert.equal(view.zenMapRevision, 0);
});

test('desktop corner X exits through the existing Zen toggle without closing the panel or losing draft', async () => {
  const {view, root} = composer(); view.buildZenExitButton(root);
  assert.equal(view.zenCloseBtn.icon, 'x');
  assert.equal(view.zenCloseBtn.getAttribute('aria-label'), t('capture.exitZen'));
  assert.equal(view.zenCloseBtn.getAttribute('title'), undefined);
  const saved=[];view.plugin.saveSettings=async()=>saved.push(view.plugin.settings.captureZenMode);
  view.textareaEl.value='Keep this draft';const image={path:'image.png'};view.pendingImages=[image];
  view.applyZenMode(true);await view.zenCloseBtn.click();await view.zenSaveQueue;
  assert.equal(view.zenMode,false);assert.equal(view.textareaEl.value,'Keep this draft');assert.equal(view.pendingImages[0],image);
  assert.deepEqual(saved,[false]);await view.zenCloseBtn.click();await view.zenSaveQueue;
  assert.deepEqual(saved,[false]); // Hidden button cannot re-enter Zen via a stale click.
});
test('mobile does not create a corner exit button', () => {
  const {view,root}=composer({mobile:true});view.buildZenExitButton(root);
  assert.equal(view.zenCloseBtn,null);assert.equal(root.querySelector('.jp-zen-close-btn'),null);
});
test('corner exit is scoped to Zen background hover and keyboard focus, without fill or normal-layout space', () => {
  const css=require('node:fs').readFileSync(path.resolve(__dirname,'../styles.css'),'utf8');
  assert.match(css,/\.jp-capture-root > \.jp-zen-close-btn\s*\{[^}]*position:\s*absolute;[^}]*display:\s*none;[^}]*background:\s*transparent !important;/);
  assert.ok(css.includes('.jp-capture-zen:hover:not(:has(.jp-capture-card:hover)) > .jp-zen-close-btn,'));
  assert.match(css,/\.jp-capture-zen > \.jp-zen-close-btn:focus-visible\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto;/);
});

})().catch(error => { console.error(error); process.exitCode = 1; });
