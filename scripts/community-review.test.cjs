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

test('CSS guard rejects new important declarations and relational selectors, retaining the keyboard exception', () => {
  const css = readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8');
  assert.deepEqual(checkCss(css), { errors: [], inlineOverrides: 1 });
  assert.ok(checkCss(css + '\n.jp-test { color: red !important; }').errors.length);
  assert.ok(checkCss(css + '\n.jp-test:has(button) { display: none; }').errors.length);
  assert.ok(checkCss(css.replace('padding-bottom: 0 !important;', 'padding-bottom: 0;')).errors.length);
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
