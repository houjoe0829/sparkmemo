// Run with: node --test scripts/geocode.test.cjs
// Uses existing esbuild + node:test, never sends network requests or writes to a vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');
const { readFileSync } = require('node:fs');

function loadSource(file, obsidian = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const contents = readFileSync(filename, 'utf8') + (file.endsWith('/geocode.ts')
    ? "\nexport { setLanguage } from './i18n';\n" : '');
  const output = buildSync({ stdin: { contents, resolveDir: path.dirname(filename), loader: 'ts' }, bundle: true, platform: 'node',
    format: 'cjs', external: ['obsidian'], write: false }).outputFiles[0].text;
  const module = new Module(filename, moduleParent);
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = module.require.bind(module);
  module.require = id => id === 'obsidian' ? obsidian : originalRequire(id);
  module._compile(output, filename);
  return module.exports;
}
const moduleParent = module;
const { ReverseGeocoder, districtName } = loadSource('src/geocode-client.ts');
const DAY = 24 * 60 * 60 * 1000;
const BASE = 1800000000000;
const collection = geocoding => ({ type: 'FeatureCollection', features: [
  { properties: { geocoding } },
] });
const cn = (label = '江岸区', admin = {}) => collection({ country_code: 'cn',
  type: 'district', name: '后湖街道', district: label, city: '武汉市',
  osm_key: 'boundary', osm_value: 'administrative',
  admin: { level4: '湖北省', level5: '武汉市', level6: label, level8: '后湖街道', ...admin },
});
const response = (data = cn(), status = 200, headers = {}) => ({
  status, headers, readJson: () => data,
});
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness(options = {}) {
  let now = BASE;
  let raw = options.raw ?? null;
  const calls = [], reports = [], writes = [], sleeps = [];
  let client;
  const storage = options.storage ?? {
    read: async () => raw,
    write: async content => { raw = content; writes.push(content); },
  };
  const create = () => new ReverseGeocoder({
    request: async url => { calls.push({ url, at: now });
      return options.request ? options.request(url, calls.length) : response(); },
    report: (kind, status) => reports.push({ kind, status }),
    storage, now: () => now,
    sleep: options.sleep ?? (async ms => { sleeps.push(ms); now += ms; }),
    timeoutMs: options.timeoutMs ?? 1000,
  });
  client = create();
  return { get client() { return client; }, calls, reports, writes, sleeps,
    advance: ms => { now += ms; }, now: () => now, raw: () => raw,
    restart: async () => { await client.flush(); client.dispose(); client = create(); },
  };
}

test('Chinese district is admin level 6, not the returned street or parent city', () => {
  assert.equal(districtName(cn()), '江岸区');
  assert.equal(districtName(cn("Jiang'an District")), "Jiang'an District");
  assert.equal(districtName(cn('秭归县')), '秭归县');
  assert.equal(districtName(cn('Yicheng City')), 'Yicheng City');
});
test('missing Chinese county stays unnamed even when a street/city is available', () => {
  assert.equal(districtName(cn('江岸区', { level6: undefined })), null);
  assert.equal(districtName(collection({ country_code: 'cn', city: '武汉市',
    name: '湖北省', admin: { level4: '湖北省', level5: '武汉市' } })), null);
});
test('normalised foreign district/county uses one name without concatenating a city', () => {
  assert.equal(districtName(collection({ country_code: 'us', county: 'New York County', city: 'New York' })), 'New York County');
  assert.equal(districtName(collection({ country_code: 'fr', district: 'Paris 7e', city: 'Paris' })), 'Paris 7e');
});
test('Tokyo ward and London borough use verified administrative district objects', () => {
  for (const [country, label, level] of [['jp', 'Shinjuku', 'level7'], ['gb', 'City of Westminster', 'level8']]) {
    assert.equal(districtName(collection({ country_code: country, type: 'district',
      name: label, osm_key: 'boundary', osm_value: 'administrative', admin: { [level]: label } })), label);
  }
});
test('does not turn an ordinary city, street, POI or mismatched boundary into a district', () => {
  for (const geo of [
    { type: 'city', name: 'London', city: 'London' },
    { type: 'district', name: 'Street', osm_key: 'highway', admin: { level8: 'Street' } },
    { type: 'district', name: 'Cafe', osm_key: 'amenity' },
    { type: 'district', name: 'Unrelated', osm_key: 'boundary', osm_value: 'administrative', admin: { level8: 'Other' } },
  ]) assert.equal(districtName(collection(geo)), null);
});
test('empty result is distinguishable from malformed JSON structures', () => {
  assert.equal(districtName({ type: 'FeatureCollection', features: [] }), null);
  for (const data of [null, {}, { address: { city: '江岸区' } },
    { type: 'FeatureCollection', features: [{}] }]) assert.throws(() => districtName(data));
});
test('one action requests one locale and preserves all coordinate digits', async () => {
  const h = harness();
  assert.equal(await h.client.resolve(30.649742123, 114.287711789, 'zh'), '江岸区');
  const url = new URL(h.calls[0].url);
  assert.equal(url.searchParams.get('accept-language'), 'zh-CN');
  assert.equal(url.searchParams.get('format'), 'geocodejson');
  assert.equal(url.searchParams.get('lat'), '30.649742123');
  assert.equal(url.searchParams.get('lon'), '114.287711789');
  assert.equal(url.searchParams.has('namedetails'), false);
  assert.equal(h.calls.length, 1);
  h.client.dispose();
});
test('invalid coordinates or unsupported locales never reach the transport', async () => {
  const h = harness();
  for (const args of [[NaN, 1, 'zh'], [91, 1, 'en'], [0, Infinity, 'en'], [0, -181, 'zh'], [0, 0, 'fr']]) {
    assert.equal(await h.client.resolve(...args), null);
  }
  assert.equal(h.calls.length, 0);
});
test('simultaneous identical requests share a single transport', async () => {
  const gate = deferred();
  const h = harness({ request: () => gate.promise });
  const promises = Array.from({ length: 12 }, () => h.client.resolve(30, 114, 'zh'));
  await turn();
  assert.equal(h.calls.length, 1);
  gate.resolve(response());
  assert.deepEqual(await Promise.all(promises), Array(12).fill('江岸区'));
  h.client.dispose();
});
test('different coordinates are serialised and request starts are at least 1.2 seconds apart', async () => {
  let active = 0, maxActive = 0;
  const h = harness({ request: async () => { active++; maxActive = Math.max(maxActive, active);
    await turn(); active--; return response(); } });
  assert.deepEqual(await Promise.all([h.client.resolve(30, 114, 'zh'), h.client.resolve(31, 114, 'zh'),
    h.client.resolve(32, 114, 'en')]), ['江岸区', '江岸区', '江岸区']);
  assert.equal(maxActive, 1);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls[1].at - h.calls[0].at >= 1200);
  assert.ok(h.calls[2].at - h.calls[1].at >= 1200);
  h.client.dispose();
});
test('cache is durable and keyed by locale; no lookup occurs on startup', async () => {
  const h = harness({ request: url => response(cn(new URL(url).searchParams.get('accept-language') === 'en'
    ? "Jiang'an District" : '江岸区')) });
  await turn(); assert.equal(h.calls.length, 0);
  assert.equal(await h.client.resolve(30, 114, 'zh'), '江岸区');
  await h.restart();
  assert.equal(await h.client.resolve(30, 114, 'zh'), '江岸区');
  assert.equal(h.calls.length, 1);
  assert.equal(await h.client.resolve(30, 114, 'en'), "Jiang'an District");
  assert.equal(h.calls.length, 2);
  await h.restart();
  assert.equal(await h.client.resolve(30, 114, 'en'), "Jiang'an District");
  assert.equal(h.calls.length, 2);
  h.client.dispose();
});
test('nearby but distinct coordinates are never merged across district boundaries', async () => {
  const h = harness({ request: (_, n) => response(cn(n === 1 ? 'A District' : 'B District')) });
  assert.equal(await h.client.resolve(30.000001, 114, 'en'), 'A District');
  assert.equal(await h.client.resolve(30.000002, 114, 'en'), 'B District');
  assert.equal(h.calls.length, 2);
});
test('scientific-notation coordinates survive cache reload without rounding or another request', async () => {
  const h = harness();
  await h.client.resolve(1e-8, -1e-9, 'en');
  await h.restart();
  assert.equal(await h.client.resolve(1e-8, -1e-9, 'en'), '江岸区');
  assert.equal(h.calls.length, 1);
});
test('reload retains the earliest next-request time as well as successful names', async () => {
  const h = harness();
  await h.client.resolve(30, 114, 'en');
  await h.restart();
  await h.client.resolve(31, 114, 'en');
  assert.ok(h.calls[1].at - h.calls[0].at >= 1200);
});
test('no district and 404 are cached for 24 hours without automatic retries', async () => {
  for (const res of [response(cn('x', { level6: null })), response(null, 404)]) {
    const h = harness({ request: () => res });
    assert.equal(await h.client.resolve(30, 114, 'en'), null);
    await h.restart();
    assert.equal(await h.client.resolve(30, 114, 'en'), null);
    assert.equal(h.calls.length, 1);
    h.advance(DAY + 1);
    assert.equal(h.calls.length, 1);
    await h.client.resolve(30, 114, 'en');
    assert.equal(h.calls.length, 2);
    h.client.dispose();
  }
});
test('403 is classified before parsing its HTML and blocks queued requests across reloads', async () => {
  const h = harness({ request: () => ({ status: 403, headers: {}, readJson() { throw new Error('HTML must not be parsed'); } }) });
  assert.deepEqual(await Promise.all([h.client.resolve(30, 114, 'zh'), h.client.resolve(31, 114, 'en')]), [null, null]);
  assert.deepEqual(h.reports, [{ kind: 'blocked', status: 403 }]);
  assert.equal(h.calls.length, 1);
  await h.restart();
  await h.client.resolve(32, 114, 'zh');
  assert.equal(h.calls.length, 1);
  h.advance(DAY + 1);
  assert.equal(h.calls.length, 1);
  await h.client.resolve(32, 114, 'zh');
  assert.equal(h.calls.length, 2);
  h.client.dispose();
});
test('cached successful names remain usable while access is blocked', async () => {
  const h = harness({ request: (_, n) => n === 1 ? response() : response(null, 403) });
  await h.client.resolve(30, 114, 'zh');
  await h.client.resolve(31, 114, 'zh');
  assert.equal(await h.client.resolve(30, 114, 'zh'), '江岸区');
  assert.equal(h.calls.length, 2);
});
test('429 and 503 honour Retry-After and drop waiting work, not retry it later', async () => {
  for (const [status, kind] of [[429, 'rate-limited'], [503, 'unavailable']]) {
    const h = harness({ request: (_, n) => n === 1 ? response(null, status, { 'Retry-After': '120' }) : response() });
    assert.deepEqual(await Promise.all([h.client.resolve(30, 114, 'en'), h.client.resolve(31, 114, 'en')]), [null, null]);
    assert.deepEqual(h.reports, [{ kind, status }]);
    await h.restart();
    h.advance(119999);
    await h.client.resolve(31, 114, 'en'); assert.equal(h.calls.length, 1);
    h.advance(1);
    assert.equal(h.calls.length, 1);
    assert.equal(await h.client.resolve(31, 114, 'en'), '江岸区');
    assert.equal(h.calls.length, 2);
  }
});
test('HTTP-date Retry-After and absent/invalid/zero values use conservative cooldowns', async () => {
  for (const [headers, pause] of [
    [{ 'retry-after': new Date(BASE + 180000).toUTCString() }, 180000],
    [{}, 60000], [{ 'Retry-After': 'invalid' }, 60000], [{ 'Retry-After': '0' }, 60000],
  ]) {
    const h = harness({ request: (_, n) => n === 1 ? response(null, 429, headers) : response() });
    await h.client.resolve(30, 114, 'en');
    h.advance(pause - 1); await h.client.resolve(31, 114, 'en'); assert.equal(h.calls.length, 1);
    h.advance(1); await h.client.resolve(31, 114, 'en'); assert.equal(h.calls.length, 2);
  }
});
test('network errors have no leaked URL/coordinate/message and no automatic retries', async () => {
  const h = harness({ request: () => { throw new Error('secret memo, https://example.test/?lat=30.123456'); } });
  assert.equal(await h.client.resolve(30.123456, 114, 'zh'), null);
  assert.deepEqual(h.reports, [{ kind: 'network', status: undefined }]);
  await h.client.resolve(30.123456, 114, 'zh');
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.stringify(h.reports).includes('30.123456'), false);
});
test('native transport timeout errors are classified separately', async () => {
  const h = harness({ request: () => Promise.reject(Object.assign(new Error('private'), { code: 'ETIMEDOUT' })) });
  await h.client.resolve(30, 114, 'zh');
  assert.deepEqual(h.reports, [{ kind: 'timeout', status: undefined }]);
});
test('a hung transport times out callers but cannot overlap with another transport', async () => {
  const gate = deferred();
  const h = harness({ request: (_, n) => n === 1 ? gate.promise : response(), timeoutMs: 5 });
  assert.equal(await h.client.resolve(30, 114, 'zh'), null);
  assert.equal(h.reports[0].kind, 'timeout');
  h.advance(60000);
  assert.equal(await h.client.resolve(31, 114, 'zh'), null);
  assert.equal(h.calls.length, 1);
  gate.resolve(response(cn('late name must not be cached')));
  await turn();
  assert.equal(await h.client.resolve(30, 114, 'zh'), '江岸区');
  assert.equal(h.calls.length, 2);
  h.client.dispose();
});
test('a late 403 or 429 still protects future actions after the caller times out', async () => {
  for (const status of [403, 429]) {
    const gate = deferred();
    const h = harness({ request: () => gate.promise, timeoutMs: 5 });
    assert.equal(await h.client.resolve(30, 114, 'zh'), null);
    h.advance(60000);
    gate.resolve(response(null, status, { 'Retry-After': '120' }));
    await turn();
    await h.restart();
    assert.equal(await h.client.resolve(31, 114, 'zh'), null);
    assert.equal(h.calls.length, 1);
    assert.equal(h.reports.at(-1).kind, status === 403 ? 'blocked' : 'rate-limited');
    h.client.dispose();
  }
});
test('malformed 200 bodies and other HTTP failures stay out of the success cache', async () => {
  for (const [first, kind] of [[response(null), 'invalid-response'], [response(null, 500), 'http-error'],
    [{ status: 200, headers: {}, readJson() { throw new Error('HTML'); } }, 'invalid-response']]) {
    const h = harness({ request: (_, n) => n === 1 ? first : response() });
    assert.equal(await h.client.resolve(30, 114, 'en'), null);
    assert.equal(h.reports[0].kind, kind);
    h.advance(30000);
    assert.equal(await h.client.resolve(30, 114, 'en'), '江岸区');
    assert.equal(h.calls.length, 2);
  }
});
test('corrupt or old-format caches fail safely and do not prevent a fresh user lookup', async () => {
  for (const raw of ['not json', '{}', JSON.stringify({ version: 1, entries: [], format: 'old' })]) {
    const h = harness({ raw });
    assert.equal(await h.client.resolve(30, 114, 'zh'), '江岸区');
    assert.equal(h.reports[0].kind, 'cache-read');
    assert.equal(h.calls.length, 1);
  }
});
test('invalid cache entries cannot inject a name, coordinate or never-expiring miss', async () => {
  const raw = JSON.stringify({ version: 1, format: 'geocodejson-district-v1', entries: [
    { key: '30,114:zh', name: null, expiresAt: null },
    { key: '31,114:zh', name: { nested: 'not text' }, expiresAt: null },
    { key: '500,114:zh', name: 'invalid coordinate', expiresAt: null },
    { key: '32,114:zh', name: 'expired', expiresAt: BASE - 1 },
  ] });
  const h = harness({ raw });
  assert.equal(await h.client.resolve(30, 114, 'zh'), '江岸区');
  assert.equal(await h.client.resolve(31, 114, 'zh'), '江岸区');
  assert.equal(await h.client.resolve(32, 114, 'zh'), '江岸区');
  assert.equal(h.calls.length, 3);
});
test('the persistent cache stays bounded when a new coordinate is added', async () => {
  const entries = Array.from({ length: 2000 }, (_, i) => ({ key: `${i / 10000},114:en`, name: 'Cached county', expiresAt: null }));
  const h = harness({ raw: JSON.stringify({ version: 1, format: 'geocodejson-district-v1', entries }) });
  await h.client.resolve(30, 114, 'en'); await h.client.flush();
  const saved = JSON.parse(h.raw()).entries;
  assert.equal(saved.length, 2000);
  assert.equal(saved.some(entry => entry.key === '0,114:en'), false);
  assert.equal(saved.at(-1).key, '30,114:en');
});
test('failed cache writes do not discard successful results or log underlying errors', async () => {
  const h = harness({ storage: { read: async () => null, write: async () => { throw new Error('private path'); } } });
  assert.equal(await h.client.resolve(30, 114, 'zh'), '江岸区');
  await h.client.flush();
  assert.equal(h.reports[0].kind, 'cache-write');
  assert.equal(await h.client.resolve(30, 114, 'zh'), '江岸区');
  assert.equal(h.calls.length, 1);
});
test('missing or oversized cache storage failures are recoverable without exposing paths', async () => {
  for (const read of [async () => { throw new Error('private filesystem path'); },
    async () => ' '.repeat(2 * 1024 * 1024 + 1)]) {
    const h = harness({ storage: { read, write: async () => {} } });
    assert.equal(await h.client.resolve(30, 114, 'zh'), '江岸区');
    assert.deepEqual(h.reports, [{ kind: 'cache-read', status: undefined }]);
  }
});
test('cache writes are serialised, even when storage is slow', async () => {
  const saved = [], gate = deferred();
  let active = 0, max = 0;
  const h = harness({ storage: { read: async () => null, write: async value => {
    active++; max = Math.max(max, active); await gate.promise; saved.push(value); active--;
  } } });
  await Promise.all([h.client.resolve(30, 114, 'zh'), h.client.resolve(31, 114, 'zh')]);
  gate.resolve(); await h.client.flush();
  assert.equal(max, 1);
  assert.equal(JSON.parse(saved.at(-1)).entries.length, 2);
});
test('unload stops queued requests, cancels caller waits and ignores late transport responses', async () => {
  const gate = deferred();
  const h = harness({ request: () => gate.promise });
  const first = h.client.resolve(30, 114, 'en'), second = h.client.resolve(31, 114, 'en');
  await turn(); h.client.dispose();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  gate.resolve(response()); await turn(); await h.client.flush();
  assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
  assert.equal(await h.client.resolve(32, 114, 'en'), null);
});
test('real interval wait is cancelled on unload instead of leaving an idle timer', async () => {
  let calls = 0;
  const client = new ReverseGeocoder({ request: async () => { calls++; return response(); },
    storage: { read: async () => null, write: async () => {} }, report: () => {} });
  await client.resolve(30, 114, 'zh');
  const pending = client.resolve(31, 114, 'zh');
  await turn(); client.dispose();
  assert.equal(await pending, null); assert.equal(calls, 1);
});
test('Obsidian adapter follows actual plugin locale, persists only its own file and unregisters', async () => {
  let locale = 'zh-CN';
  const urls = [], files = new Map(), cleanups = [];
  const { initializeGeocoding, reverseGeocodeCity, setLanguage } = loadSource('src/geocode.ts', {
    getLanguage: () => locale, moment: { locale: () => 'en' }, normalizePath: value => value,
    requestUrl: async options => {
      assert.equal(options.throw, false);
      assert.equal(options.headers['User-Agent'], 'SparkMemo-Obsidian-Plugin');
      urls.push(options.url);
      const english = new URL(options.url).searchParams.get('accept-language') === 'en';
      return { status: 200, headers: {}, json: cn(english ? "Jiang'an District" : '江岸区') };
    },
  });
  const plugin = { manifest: { id: 'spark-memo', dir: '.custom/plugins/spark-memo' },
    app: { vault: { configDir: '.custom', adapter: {
      exists: async file => files.has(file), stat: async () => ({ size: 100 }),
      read: async file => files.get(file), write: async (file, text) => { files.set(file, text); },
    } } }, register: callback => cleanups.push(callback) };
  assert.equal(await reverseGeocodeCity(30, 114), null);
  initializeGeocoding(plugin); await turn(); assert.equal(urls.length, 0);
  assert.equal(await reverseGeocodeCity(30, 114), '江岸区');
  locale = 'fr';
  assert.equal(await reverseGeocodeCity(30, 114), "Jiang'an District");
  locale = 'en';
  assert.equal(await reverseGeocodeCity(30, 114), "Jiang'an District");
  // The concurrent settings change adds an explicit plugin-language preference.
  // Location lookups must follow that preference, not always the host's language.
  setLanguage('zh');
  assert.equal(await reverseGeocodeCity(30, 114), '江岸区');
  locale = 'zh'; setLanguage('en');
  assert.equal(await reverseGeocodeCity(30, 114), "Jiang'an District");
  setLanguage('system');
  assert.equal(urls.length, 2);
  assert.deepEqual([...files.keys()], ['.custom/plugins/spark-memo/geocode-cache.json']);
  cleanups.forEach(fn => fn());
  assert.equal(await reverseGeocodeCity(31, 114), null);
  assert.equal(urls.length, 2);
});

test('all registered languages request only their own locale and reuse separate durable caches', async () => {
  const { LANGUAGE_PROFILES, SUPPORTED_LOCALES } = loadSource('src/languages.ts');
  const h = harness({ request: url => response(cn(new URL(url).searchParams.get('accept-language'))) });
  for (const locale of SUPPORTED_LOCALES) {
    const expected = LANGUAGE_PROFILES[locale].requestLanguage;
    assert.equal(await h.client.resolve(30, 114, locale), expected);
    const url = new URL(h.calls.at(-1).url);
    assert.equal(url.searchParams.get('accept-language'), expected);
    assert.equal(url.searchParams.getAll('accept-language').length, 1);
    assert.ok(!url.searchParams.has('namedetails'));
  }
  assert.equal(h.calls.length, SUPPORTED_LOCALES.length);
  assert.ok(h.calls.every((call, i) => i === 0 || call.at - h.calls[i - 1].at >= 1200));
  await h.restart();
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(await h.client.resolve(30, 114, locale), LANGUAGE_PROFILES[locale].requestLanguage);
  }
  assert.equal(h.calls.length, SUPPORTED_LOCALES.length);
  const cache = JSON.parse(h.raw());
  assert.equal(cache.entries.length, SUPPORTED_LOCALES.length);
  assert.ok(cache.entries.some(entry => entry.key === '30,114:zh'));
  assert.ok(cache.entries.some(entry => entry.key === '30,114:en'));
  assert.ok(cache.entries.some(entry => entry.key === '30,114:zh-TW'));
  assert.ok(cache.entries.some(entry => entry.key === '30,114:ja'));
  h.client.dispose();
});

test('Obsidian traditional/Japanese aliases and explicit preferences reach the single-language transport', async () => {
  let host = 'zh-HK';
  const urls = [], files = new Map();
  const api = loadSource('src/geocode.ts', {
    getLanguage: () => host, moment: { locale: () => 'en' }, normalizePath: value => value,
    requestUrl: async ({ url }) => {
      urls.push(url);
      return { status: 200, headers: {}, json: cn(new URL(url).searchParams.get('accept-language')) };
    },
  });
  api.initializeGeocoding({ manifest: { id: 'spark-memo', dir: '.custom/plugins/spark-memo' },
    app: { vault: { adapter: { exists: async file => files.has(file), stat: async () => ({ size: 100 }),
      read: async file => files.get(file), write: async (file, text) => { files.set(file, text); } } } },
    register() {} });
  assert.equal(await api.reverseGeocodeCity(30, 114), 'zh-Hant');
  host = 'ja-JP';
  assert.equal(await api.reverseGeocodeCity(30, 114), 'ja');
  host = 'en'; api.setLanguage('zh-TW');
  assert.equal(await api.reverseGeocodeCity(30, 114), 'zh-Hant');
  api.setLanguage('ja');
  assert.equal(await api.reverseGeocodeCity(30, 114), 'ja');
  assert.equal(urls.length, 2);
});

test('district parser rejects unverified feature values before reading their properties', () => {
  for (const feature of [null, undefined, false, 42, 'private response', [],
    { properties: null }, { properties: [] }, { properties: { geocoding: 'not an object' } }]) {
    assert.throws(() => districtName({ type: 'FeatureCollection', features: [feature] }), /Invalid geocode response/);
  }
});
test('non-Error rejection values retain timeout classification without leaking their contents', async () => {
  for (const [error, kind] of [
    [null, 'network'], [undefined, 'network'], ['private response', 'network'], [42, 'network'],
    [{ message: 'private coordinates' }, 'network'], [{ name: 'TimeoutError', message: 'private' }, 'timeout'],
    [{ code: 'ETIMEDOUT', message: 'private' }, 'timeout'], [{ code: 'OTHER', message: 'private' }, 'network'],
  ]) {
    const h = harness({ request: () => Promise.reject(error) });
    assert.equal(await h.client.resolve(30, 114, 'zh'), null);
    assert.deepEqual(h.reports, [{ kind, status: undefined }]);
    assert.equal(h.calls.length, 1);
    await h.client.flush(); h.client.dispose();
  }
});
test('cache eviction keeps insertion order even after a hit and survives reload', async () => {
  const entries = Array.from({ length: 2000 }, (_, i) => ({ key: `${i / 10000},114:en`, name: `Cached county ${i}`, expiresAt: null }));
  const h = harness({ raw: JSON.stringify({ version: 1, format: 'geocodejson-district-v1', entries }) });
  assert.equal(await h.client.resolve(0, 114, 'en'), 'Cached county 0');
  assert.equal(h.calls.length, 0);
  assert.equal(await h.client.resolve(30, 114, 'en'), '江岸区');
  await h.client.flush();
  assert.deepEqual(JSON.parse(h.raw()).entries.map(entry => entry.key), [...entries.slice(1).map(entry => entry.key), '30,114:en']);
  await h.restart();
  assert.equal(await h.client.resolve(0.0001, 114, 'en'), 'Cached county 1');
  assert.equal(h.calls.length, 1);
  assert.equal(await h.client.resolve(0, 114, 'en'), '江岸区');
  assert.equal(h.calls.length, 2);
  await h.client.flush(); h.client.dispose();
});
