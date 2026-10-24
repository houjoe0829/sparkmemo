import { getLanguage, moment } from 'obsidian';
import { isLocale, resolveHostLocale } from './languages';
import type { Locale, LanguagePreference } from './languages';
import en, { TranslationDictionary, TranslationKey } from './locales/en';
import zh from './locales/zh';
import zhTW from './locales/zh-TW';
import ja from './locales/ja';
export type { Locale, LanguagePreference } from './languages';

let language: LanguagePreference = 'system';

/** Unknown values from synced or older settings keep following Obsidian. */
export function normalizeLanguage(value: unknown): LanguagePreference {
  return isLocale(value) ? value : 'system';
}

/** Updates only Spark Memo's translations, never Obsidian or moment globals. */
export function setLanguage(value: unknown): void {
  language = normalizeLanguage(value);
}

const dictionaries: Record<Locale, TranslationDictionary> = { en, zh, 'zh-TW': zhTW, ja };

/** Older Obsidian versions expose their language only through moment. */
function detectLocale(): Locale {
  let raw: unknown;
  try { raw = getLanguage(); } catch { raw = moment.locale(); }
  return resolveHostLocale(raw);
}

export function currentLocale(): Locale {
  return language === 'system' ? detectLocale() : language;
}

/** English/key fallback; {{name}} interpolation never changes host globals. */
export function t(key: string, vars?: Record<string, string>): string {
  const translationKey = key as TranslationKey;
  let str = dictionaries[currentLocale()][translationKey] ?? dictionaries.en[translationKey] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      str = str.replace(`{{${name}}}`, value);
    }
  }
  return str;
}
