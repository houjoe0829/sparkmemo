const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { checkCss } = require('./check-css.cjs');

function load(file, obsidian) {
  const filename = path.resolve(__dirname, '..', file);
  const code = buildSync({ entryPoints: [filename], bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['obsidian'], loader: { '.wasm': 'binary' } }).outputFiles[0].text;
  const loaded = new Module(filename, module);
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = id => id === 'obsidian' ? obsidian : original(id);
  loaded._compile(code, filename);
  return loaded.exports;
}

test('the date factory delegates to Obsidian without bundling another Moment runtime', () => {
  const calls = [];
  const result = { hostMoment: true };
  const host = { moment: input => { calls.push(input); return result; } };
  const { createMoment } = load('src/moment.ts', host);
  for (const input of [undefined, new Date(2026, 0, 15), { year: 2026, month: 0, day: 1 }]) {
    assert.equal(createMoment(input), result);
    assert.equal(calls.at(-1), input);
  }
  const built = buildSync({ entryPoints: [path.resolve(__dirname, '../src/moment.ts')],
    bundle: true, format: 'cjs', platform: 'node', write: false, metafile: true,
    external: ['obsidian'] });
  assert.ok(!Object.keys(built.metafile.inputs).some(file => file.includes('node_modules/moment/')));
});

test('stats keep full, incremental and deleted-year scans equivalent after null-safe narrowing', async () => {
  const previousWindow = global.window;
  const moment = require('moment');
  class TFile {
    constructor(basename, text) { this.basename = basename; this.path = `${basename}.md`; this.text = text; }
  }
  class TFolder { constructor() { this.children = []; } }
  const folder = new TFolder();
  const reads = [];
  const vault = {
    getAbstractFileByPath: () => folder,
    cachedRead: async file => { reads.push(file.basename); return file.text; },
  };
  global.window = { moment, app: { vault,
    internalPlugins: { plugins: { 'daily-notes': { enabled: true } },
      getPluginById: () => ({ instance: { options: {} } }) },
    plugins: { getPlugin: () => null },
  } };
  try {
    const { JournalCaptureView } = load('src/capture-view.ts', {
      moment, TFile, TFolder, ItemView: class {}, Modal: class {}, FuzzySuggestModal: class {},
      getLanguage: () => 'en', normalizePath: value => value,
      Vault: { recurseChildren: (root, callback) => root.children.forEach(callback) },
    });
    const view = Object.create(JournalCaptureView.prototype);
    view.app = { vault };
    view.plugin = { settings: { targetHeading: 'Memo', headingLevel: 2, timestampPattern: '\\d{2}:\\d{2}' } };
    view.statsLoading = false; view.dirtyYears = null;
    view.allYearStats = new Map(); view.yearCities = new Map();
    view.renderStatsLoading = () => {}; view.renderStatsContent = () => {};
    view.renderStatsError = message => assert.fail(message);
    folder.children = [
      new TFile('2025-01-01', '## Memo\n- 10:00 First [A](geo:30,114)\n'),
      new TFile('2026-01-01', '## Memo\n- 10:00 Second [B](geo:31,114)\n'),
      new TFile('2026-01-02', '## Memo\n- 11:00 Third [B](geo:31,114)\n'),
    ];
    await view.loadAllStats();
    assert.equal(view.allYearStats.get(2025).totalEntries, 1);
    assert.equal(view.allYearStats.get(2026).totalEntries, 2);
    assert.equal(view.statsLocationCount, 2);
    assert.equal(view.dirtyYears.size, 0);
    const untouched = view.allYearStats.get(2025);
    reads.length = 0; view.dirtyYears = new Set([2026]);
    await view.loadAllStats();
    assert.deepEqual(reads, ['2026-01-01', '2026-01-02']);
    assert.equal(view.allYearStats.get(2025), untouched);
    assert.equal(view.allYearStats.get(2026).totalEntries, 2);
    folder.children = folder.children.filter(file => file.basename.startsWith('2025'));
    reads.length = 0; view.dirtyYears = new Set([2026]);
    await view.loadAllStats();
    assert.deepEqual(reads, []);
    assert.equal(view.allYearStats.has(2026), false);
    assert.equal(view.yearCities.has(2026), false);
    assert.equal(view.statsLocationCount, 1);
    assert.equal(view.statsLoading, false);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('CSS guard rejects every important declaration, including the former keyboard exception', () => {
  const css = readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
  assert.deepEqual(checkCss(css), { errors: [] });
  assert.ok(checkCss(css + '\n.jp-test { color: red !important; }').errors.length);
  assert.ok(checkCss(css + '\n.jp-test:has(button) { display: none; }').errors.length);
  assert.ok(checkCss(css + '\n.is-mobile .jp-capture-root { padding-bottom: 0 !important; }').errors.length);
});

test('all locked Moment copies use the patched version without bundling a second runtime', () => {
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.resolve(__dirname, '../package-lock.json'), 'utf8'));
  assert.equal(pkg.overrides.moment, '2.31.0');
  const copies = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/moment$/.test(name));
  assert.ok(copies.length > 0);
  for (const [name, entry] of copies) assert.equal(entry.version, '2.31.0', name);
  assert.equal(require('moment').version, '2.31.0');
});

test('mobile capture padding removes only the host bottom inset, observes repeat writes and restores on close', () => {
  const previous = global.MutationObserver;
  const platform = { isMobile: true }; const observers = [];
  global.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(root, options) { this.root = root; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  try {
    const { JournalCaptureView } = load('src/capture-view.ts', {
      moment: require('moment'), Platform: platform, ItemView: class {}, Modal: class {},
      FuzzySuggestModal: class {}, getLanguage: () => 'en',
    });
    const view = Object.create(JournalCaptureView.prototype);
    const props = new Map([['padding-bottom', '372px'], ['color', 'purple']]);
    const root = { style: {
      getPropertyValue: key => props.get(key) || '',
      getPropertyPriority: () => '',
      removeProperty: key => props.delete(key),
      setProperty: (key, value) => props.set(key, value),
    } };
    view.setupMobileRootPadding(root);
    assert.equal(props.has('padding-bottom'), false);
    const observer = observers[0];
    assert.equal(observer.root, root);
    assert.deepEqual(observer.options, { attributes: true, attributeFilter: ['style'] });
    props.set('padding-bottom', '284px'); observer.callback();
    assert.equal(props.has('padding-bottom'), false);
    observer.callback(); // Its own removal must not spin or reset the last host inset.
    assert.equal(props.get('color'), 'purple');
    view.mobilePaddingCleanup();
    assert.equal(observer.disconnected, true);
    assert.equal(props.get('padding-bottom'), '284px');
    platform.isMobile = false; view.mobilePaddingCleanup = null;
    view.setupMobileRootPadding(root);
    assert.equal(observers.length, 1);
    assert.equal(props.get('padding-bottom'), '284px');
    assert.equal(view.mobilePaddingCleanup, null);
  } finally {
    if (previous === undefined) delete global.MutationObserver; else global.MutationObserver = previous;
  }
});

test('vault image save/copy reads binary locally without issuing a network request', async () => {
  class TFile { constructor() { this.extension = 'PNG'; } }
  const file = new TFile(); const reads = []; const bytes = new Uint8Array([1, 2, 3]).buffer;
  const { readPreviewImage } = load('src/image-blob.ts', { TFile, requestUrl: () => assert.fail('No network for vault images') });
  const vault = { getAbstractFileByPath: p => p === 'photo.png' ? file : null,
    readBinary: async f => { assert.equal(f, file); reads.push(f); return bytes; } };
  const blob = await readPreviewImage(vault, { src: 'app://vault/photo.png', path: 'photo.png' });
  assert.equal(blob.type, 'image/png'); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(bytes));
  assert.equal(reads.length, 1);
  await assert.rejects(readPreviewImage(vault, { src: 'app://vault/missing.png', path: 'missing.png' }), /not found/);
});

test('HTTP images use requestUrl and retain their original MIME and bytes; failures propagate', async () => {
  const calls = []; const bytes = new Uint8Array([9, 8]).buffer;
  const { readPreviewImage } = load('src/image-blob.ts', { TFile: class {}, requestUrl: async opts => {
    calls.push(opts); if (opts.url.endsWith('fail')) throw Error('remote failure');
    return { headers: { 'Content-Type': 'image/webp; charset=binary' }, arrayBuffer: bytes };
  } });
  const blob = await readPreviewImage({}, { src: 'https://example.com/image.webp' });
  assert.equal(blob.type, 'image/webp'); assert.equal(blob.size, 2);
  assert.deepEqual(calls, [{ url: 'https://example.com/image.webp' }]);
  await assert.rejects(readPreviewImage({}, { src: 'https://example.com/fail' }), /remote failure/);
});

test('browser-owned image URLs use local blob loading rather than requestUrl', async () => {
  const previous = global.XMLHttpRequest;
  const calls = [];
  global.XMLHttpRequest = class {
    open(method, url) { calls.push({ method, url }); this.url = url; }
    send() { this.status = this.url.endsWith('missing') ? 404 : 200; this.response = new Blob(['image'], { type: 'image/png' }); this.onload(); }
  };
  try {
    const { readPreviewImage } = load('src/image-blob.ts', { TFile: class {}, requestUrl: () => assert.fail('Local URL must not reach network') });
    for (const src of ['blob:preview', 'data:image/png;base64,AA==', 'app://vault/local']) {
      const blob = await readPreviewImage({}, { src }); assert.equal(blob.type, 'image/png'); assert.equal(blob.size, 5);
    }
    await assert.rejects(readPreviewImage({}, { src: 'blob:missing' }), /404/);
    assert.equal(calls.length, 4);
  } finally { global.XMLHttpRequest = previous; }
});

test('the actual inlined WebP WASM encoder initializes, encodes and reuses its module', async () => {
  const { encodeWebp } = load('src/webp-encoder.ts');
  const image = { data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]), width: 2, height: 1 };
  for (const quality of [0.5, 0.8]) {
    const encoded = Buffer.from(await encodeWebp(image, { quality: quality * 100 }));
    assert.equal(encoded.toString('ascii', 0, 4), 'RIFF'); assert.equal(encoded.toString('ascii', 8, 12), 'WEBP');
    assert.ok(encoded.length > 12);
  }
});
