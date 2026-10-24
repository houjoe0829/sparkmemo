/** One required profile per UI language: formatting and geocoding cannot drift. */
interface LanguageProfile {
  nativeName: string;
  hostAliases: readonly string[];
  requestLanguage: string;
  momentLocale: string;
  numberLocale: string;
  calendarMonthFormat: string;
  heatmapMonthFormat: string;
  calendarWeekdays: readonly string[];
  largeNumberUnit: string | null;
}

export const LANGUAGE_PROFILES = {
  zh: {
    nativeName: '简体中文', hostAliases: ['zh', 'zh-CN', 'zh-SG', 'zh-Hans'],
    requestLanguage: 'zh-CN', momentLocale: 'zh-cn', numberLocale: 'zh-CN',
    calendarMonthFormat: 'YYYY年M月', heatmapMonthFormat: 'M月',
    calendarWeekdays: ['日', '一', '二', '三', '四', '五', '六'], largeNumberUnit: '万',
  },
  'zh-TW': {
    nativeName: '繁體中文', hostAliases: ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant'],
    requestLanguage: 'zh-Hant', momentLocale: 'zh-tw', numberLocale: 'zh-TW',
    calendarMonthFormat: 'YYYY年M月', heatmapMonthFormat: 'M月',
    calendarWeekdays: ['日', '一', '二', '三', '四', '五', '六'], largeNumberUnit: '萬',
  },
  en: {
    nativeName: 'English', hostAliases: ['en'],
    requestLanguage: 'en', momentLocale: 'en', numberLocale: 'en-US',
    calendarMonthFormat: 'MMMM YYYY', heatmapMonthFormat: 'MMM',
    calendarWeekdays: ['S', 'M', 'T', 'W', 'T', 'F', 'S'], largeNumberUnit: null,
  },
  ja: {
    nativeName: '日本語', hostAliases: ['ja'],
    requestLanguage: 'ja', momentLocale: 'ja', numberLocale: 'ja-JP',
    calendarMonthFormat: 'YYYY年M月', heatmapMonthFormat: 'M月',
    calendarWeekdays: ['日', '月', '火', '水', '木', '金', '土'], largeNumberUnit: '万',
  },
} satisfies Record<string, LanguageProfile>;

export type Locale = keyof typeof LANGUAGE_PROFILES;
export type LanguagePreference = 'system' | Locale;
export const SUPPORTED_LOCALES = Object.keys(LANGUAGE_PROFILES) as Locale[];

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGE_PROFILES, value);
}

/** Prefer a specific script/region over a generic language prefix. */
export function resolveHostLocale(raw: unknown): Locale {
  if (typeof raw !== 'string') return 'en';
  const code = raw.replace(/_/g, '-').toLowerCase();
  const aliases = SUPPORTED_LOCALES.flatMap(locale =>
    LANGUAGE_PROFILES[locale].hostAliases.map(alias => ({ locale, alias: alias.toLowerCase() })),
  ).sort((a, b) => b.alias.length - a.alias.length);
  return aliases.find(({ alias }) => code === alias || code.startsWith(`${alias}-`))?.locale ?? 'en';
}
