// Run with node --test scripts/languages.test.cjs. No network or vault access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
let host = 'en', hostCalls = 0, momentCalls = 0, legacy = false;
const filename = path.resolve(__dirname, '../src/i18n.ts');
const source = readFileSync(filename, 'utf8') + `
export { dictionaries };
export * from './languages';
export { formatWordCount } from './stats';
`;
const output = buildSync({ stdin: { contents: source, resolveDir: path.dirname(filename), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false }).outputFiles[0].text;
const loaded = new Module(filename, module);
const originalRequire = loaded.require.bind(loaded);
loaded.require = id => id === 'obsidian' ? {
  getLanguage() { hostCalls++; if (legacy) throw Error('Unavailable'); return host; },
  moment: { locale() { momentCalls++; return host; } },
} : originalRequire(id);
loaded._compile(output, filename);
const { dictionaries, LANGUAGE_PROFILES, SUPPORTED_LOCALES, resolveHostLocale, isLocale,
  setLanguage, normalizeLanguage, currentLocale, t, formatWordCount } = loaded.exports;
const placeholders = text => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();

test('every supported language has exactly the same nonempty translation keys and placeholders', () => {
  assert.deepEqual(Object.keys(dictionaries).sort(), [...SUPPORTED_LOCALES].sort());
  const keys = Object.keys(dictionaries.en).sort();
  assert.ok(keys.length >= 281);
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), keys, locale);
    for (const key of keys) {
      const text = dictionaries[locale][key];
      assert.equal(typeof text, 'string', `${locale}:${key}`);
      assert.ok(text.trim(), `${locale}:${key}`);
      assert.deepEqual(placeholders(text), placeholders(dictionaries.en[key]), `${locale}:${key}`);
      setLanguage(locale);
      const vars = Object.fromEntries(placeholders(text).map(name => [name, `value_${name}`]));
      const translated = t(key, vars);
      assert.ok(!translated.includes('{{'), `${locale}:${key}`);
      for (const value of Object.values(vars)) assert.ok(translated.includes(value));
    }
  }
});
test('every literal translation key used by source code exists in all dictionaries', () => {
  for (const file of readdirSync(path.dirname(filename)).filter(file => file.endsWith('.ts'))) {
    const content = readFileSync(path.join(path.dirname(filename), file), 'utf8');
    for (const [, key] of content.matchAll(/\bt\('([^']+)'/g)) {
      for (const locale of SUPPORTED_LOCALES) assert.ok(Object.hasOwn(dictionaries[locale], key), `${file}:${locale}:${key}`);
    }
  }
});
test('host aliases distinguish traditional script/regions and Japanese with English fallback', () => {
  const cases = {
    zh: 'zh', 'zh-CN': 'zh', 'zh-SG': 'zh', 'zh-Hans': 'zh', 'zh-Hans-TW': 'zh',
    'zh-TW': 'zh-TW', 'ZH_tw': 'zh-TW', 'zh-HK': 'zh-TW', 'zh-MO': 'zh-TW',
    'zh-Hant': 'zh-TW', 'zh-Hant-HK': 'zh-TW', 'ja': 'ja', 'ja-JP': 'ja',
    'en-GB': 'en', 'fr': 'en', 'zhish': 'en', 'jaaaa': 'en', '': 'en',
  };
  for (const [raw, expected] of Object.entries(cases)) {
    assert.equal(resolveHostLocale(raw), expected, raw);
    host = raw; setLanguage('system'); assert.equal(currentLocale(), expected, raw);
  }
  assert.equal(resolveHostLocale(null), 'en');
  for (const raw of ['zh-tw', 'ja-JP', 'toString', '__proto__', null, 42]) {
    assert.equal(isLocale(raw), false); assert.equal(normalizeLanguage(raw), 'system');
  }
});
test('each profile supplies UI, dates, number formats and exactly one geocode language', () => {
  const nativeNames = new Set(), apiLanguages = new Set();
  for (const locale of SUPPORTED_LOCALES) {
    const profile = LANGUAGE_PROFILES[locale];
    assert.ok(profile.nativeName.trim()); nativeNames.add(profile.nativeName);
    assert.ok(profile.hostAliases.length);
    for (const alias of profile.hostAliases) assert.equal(resolveHostLocale(alias), locale);
    assert.match(profile.requestLanguage, /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/);
    apiLanguages.add(profile.requestLanguage);
    assert.ok(profile.momentLocale && profile.calendarMonthFormat && profile.heatmapMonthFormat);
    assert.equal(profile.calendarWeekdays.length, 7);
    assert.ok(profile.calendarWeekdays.every(day => day.length > 0));
    assert.doesNotThrow(() => new Intl.NumberFormat(profile.numberLocale).format(12345));
    assert.ok(profile.largeNumberUnit === null || profile.largeNumberUnit.length > 0);
  }
  assert.equal(nativeNames.size, SUPPORTED_LOCALES.length);
  assert.equal(apiLanguages.size, SUPPORTED_LOCALES.length);
  assert.equal(LANGUAGE_PROFILES['zh-TW'].requestLanguage, 'zh-Hant');
  assert.equal(LANGUAGE_PROFILES.ja.requestLanguage, 'ja');
});
test('manual preferences persist canonical language codes without consulting host globals', () => {
  host = 'fr'; legacy = false;
  for (const locale of SUPPORTED_LOCALES) {
    const before = [hostCalls, momentCalls];
    assert.equal(normalizeLanguage(locale), locale);
    setLanguage(locale); assert.equal(currentLocale(), locale);
    assert.equal(t('settings.tabs.general'), dictionaries[locale]['settings.tabs.general']);
    assert.deepEqual([hostCalls, momentCalls], before);
  }
  for (const code of ['zh-TW', 'ja']) {
    legacy = true; host = code; setLanguage('system'); assert.equal(currentLocale(), code);
  }
  legacy = false;
});
test('large word totals use 萬 in traditional Chinese and 万 in Japanese without changing old formats', () => {
  for (const locale of ['zh', 'zh-TW', 'ja']) {
    const unit = LANGUAGE_PROFILES[locale].largeNumberUnit;
    assert.equal(formatWordCount(9999, locale), '9999');
    assert.equal(formatWordCount(32000, locale), `3.2 ${unit}`);
    assert.equal(formatWordCount(123456, locale), `12 ${unit}`);
  }
  assert.equal(formatWordCount(12345, 'en'), '12.3K');
  assert.equal(t('missing.key'), 'missing.key');
});
