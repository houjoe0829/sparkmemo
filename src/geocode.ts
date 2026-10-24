/** Obsidian adapter shared by photo metadata, mobile positioning and manual retries. */
import { normalizePath, requestUrl } from 'obsidian';
import type { Plugin } from 'obsidian';
import { ReverseGeocoder } from './geocode-client';
import { currentLocale } from './i18n';

let client: ReverseGeocoder | null = null;

/** Cache is separate from settings and only accessed when the plugin is running. */
export function initializeGeocoding(plugin: Plugin): void {
  client?.dispose();
  const adapter = plugin.app.vault.adapter;
  const directory = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
  const cachePath = normalizePath(`${directory}/geocode-cache.json`);
  const instance = new ReverseGeocoder({
    request: async url => {
      const response = await requestUrl({
        url,
        headers: { 'User-Agent': 'SparkMemo-Obsidian-Plugin' },
        throw: false,
      });
      return { status: response.status, headers: response.headers, readJson: () => response.json };
    },
    storage: {
      read: async () => {
        if (!(await adapter.exists(cachePath))) return null;
        const stat = await adapter.stat(cachePath);
        if (stat && stat.size > 2 * 1024 * 1024) throw new Error('Cache too large');
        return adapter.read(cachePath);
      },
      write: content => adapter.write(cachePath, content),
    },
    // Never log URLs, raw errors, coordinates, response bodies or memo content.
    report: (kind, status) => console.warn('[Spark Memo] Geocoding', { kind, ...(status ? { status } : {}) }),
  });
  client = instance;
  plugin.register(() => {
    instance.dispose();
    if (client === instance) client = null;
  });
}

/** One requested language per user action; failures preserve the caller's coordinates. */
export async function reverseGeocodeCity(latitude: number, longitude: number): Promise<string | null> {
  return client ? client.resolve(latitude, longitude, currentLocale()) : null;
}
