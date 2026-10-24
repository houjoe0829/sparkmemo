/**
 * Obsidian-independent, user-triggered reverse geocoder.
 * One locale per request; no background scans, automatic retries or grid rounding.
 * The local queue cannot enforce Nominatim's application-wide traffic limit.
 */
import { LANGUAGE_PROFILES, isLocale } from './languages';
import type { Locale } from './languages';
export type GeocodeLocale = Locale;
export type GeocodeFailure = 'blocked' | 'rate-limited' | 'unavailable' | 'network' |
  'timeout' | 'http-error' | 'invalid-response' | 'no-district' | 'cache-read' | 'cache-write';

export interface GeocodeResponse {
  status: number;
  headers: Record<string, string>;
  // Inspect an HTML error's status before attempting JSON parsing.
  readJson(): unknown;
}
export interface GeocodeStorage {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}
interface Dependencies {
  request(url: string): Promise<GeocodeResponse>;
  storage: GeocodeStorage;
  report(kind: GeocodeFailure, status?: number): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
type RecordValue = Record<string, unknown>;
interface CacheEntry { name: string | null; expiresAt: number | null }
const DAY = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 2000;
const CACHE_FORMAT = 'geocodejson-district-v1';

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function name(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 300
    ? value.trim() : null;
}

/**
 * JSONv2's `city` may mean a district in China, and the object's name may be a
 * street. Use standardised administrative data. Chinese county-level cities
 * are also admin level 6; never use a Chinese level-8 street as a district.
 * Elsewhere, use normalised districts/counties or an administrative district.
 */
export function districtName(data: unknown): string | null {
  if (!record(data) || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('Invalid geocode response');
  }
  if (data.features.length === 0) return null;
  const feature = data.features[0];
  const geo = record(feature) && record(feature.properties) ? feature.properties.geocoding : null;
  if (!record(geo)) throw new Error('Invalid geocode response');
  const admin = record(geo.admin) ? geo.admin : {};
  if (geo.country_code === 'cn') return name(admin.level6);
  const district = name(geo.district) ?? name(geo.county);
  if (district) return district;
  const ownName = name(geo.name);
  if (ownName && (geo.type === 'district' || geo.type === 'county') &&
      geo.osm_key === 'boundary' && geo.osm_value === 'administrative' &&
      Object.values(admin).some(value => value === ownName)) return ownName;
  return null;
}
function validCoordinate(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
function validKey(key: string): boolean {
  const parts = key.split(':');
  if (parts.length !== 2 || !isLocale(parts[1])) return false;
  const coords = parts[0].split(',');
  return coords.length === 2 && coords.every(value => String(Number(value)) === value) &&
    validCoordinate(Number(coords[0]), Number(coords[1]));
}
/** Honour both delta-seconds and HTTP-date Retry-After values, with a safe minimum. */
function retryDelay(headers: Record<string, string>, now: number, fallback: number): number {
  const key = Object.keys(headers).find(value => value.toLowerCase() === 'retry-after');
  const raw = key ? headers[key].trim() : '';
  const delay = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(delay) ? Math.max(fallback, delay) : fallback;
}

export class ReverseGeocoder {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly ready: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private cooldownUntil = 0;
  private blockedUntil = 0;
  private disposed = false;
  private transportActive = false;
  private cancelWait: (() => void) | null = null;
  private cancelRequest: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.ready = this.load();
  }
  async resolve(lat: number, lon: number, locale: GeocodeLocale): Promise<string | null> {
    if (this.disposed || !validCoordinate(lat, lon) || !isLocale(locale)) return null;
    await this.ready;
    if (this.disposed) return null;
    // Exact coordinates, not a rounded grid that could merge adjacent districts.
    const key = `${lat},${lon}:${locale}`;
    const cached = this.cached(key);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const job = this.tail.then(() => this.lookup(lat, lon, locale, key));
    this.pending.set(key, job);
    this.tail = job.then(() => { this.pending.delete(key); }, () => { this.pending.delete(key); });
    return job;
  }
  /** Unloading cancels waits; late responses cannot create new cache/UI updates. */
  dispose(): void {
    this.disposed = true;
    this.cancelWait?.();
    this.cancelRequest?.();
  }
  async flush(): Promise<void> { await this.writes; }

  private cached(key: string): string | null | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.name;
  }
  private async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (this.deps.sleep) { await this.deps.sleep(ms); return; }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.cancelWait = null; resolve(); }, ms);
      this.cancelWait = () => { clearTimeout(timer); this.cancelWait = null; resolve(); };
    });
  }
  private guarded(): boolean {
    return this.disposed || this.transportActive || this.now() < this.blockedUntil || this.now() < this.cooldownUntil;
  }
  private async lookup(lat: number, lon: number, locale: GeocodeLocale, key: string): Promise<string | null> {
    if (this.disposed) return null;
    const cached = this.cached(key);
    if (cached !== undefined) return cached;
    // Cooldowns do not schedule future retries. A new user action is required.
    if (this.guarded()) return null;
    await this.wait(this.nextRequestAt - this.now());
    if (this.guarded()) return null;
    this.nextRequestAt = this.now() + 1200;
    const url = 'https://nominatim.openstreetmap.org/reverse?format=geocodejson&addressdetails=1&zoom=10' +
      `&lat=${lat}&lon=${lon}&accept-language=${encodeURIComponent(LANGUAGE_PROFILES[locale].requestLanguage)}`;
    this.transportActive = true;
    let abandoned = false;
    const request = Promise.resolve().then(() => this.deps.request(url)).then(
      response => {
        // A late success is ignored, but a late access restriction still protects
        // the next user action. No more requests are made in either case.
        if (abandoned && !this.disposed) this.restrict(response);
        return { type: 'response' as const, response };
      },
      error => ({ type: 'error' as const, error }),
    ).finally(() => { this.transportActive = false; });
    // requestUrl cannot abort. Time out the caller, but guard against starting
    // another transport until the real request settles, even after our deadline.
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<{ type: 'timeout' } | { type: 'cancelled' }>(resolve => {
      timer = setTimeout(() => resolve({ type: 'timeout' }), this.deps.timeoutMs ?? 20000);
      this.cancelRequest = () => resolve({ type: 'cancelled' });
    });
    const outcome = await Promise.race([request, deadline]);
    clearTimeout(timer!);
    this.cancelRequest = null;
    if (this.disposed || outcome.type === 'cancelled') return null;
    if (outcome.type === 'timeout') {
      abandoned = true;
      return this.fail('timeout', 30000);
    }
    if (outcome.type === 'error') {
      const error = outcome.error;
      const timedOut = record(error) && (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT');
      return this.fail(timedOut ? 'timeout' : 'network', 30000);
    }
    const { response } = outcome;
    const { status } = response;
    if (this.restrict(response)) return null;
    if (status === 404) return this.remember(key, null);
    if (status !== 200) return this.fail('http-error', 30000, status);
    try {
      const result = districtName(response.readJson());
      if (!result) this.deps.report('no-district');
      return this.remember(key, result);
    } catch {
      return this.fail('invalid-response', 30000, status);
    }
  }
  private restrict(response: GeocodeResponse): boolean {
    const { status } = response;
    if (status === 403) {
      this.blockedUntil = this.now() + retryDelay(response.headers, this.now(), DAY);
      this.deps.report('blocked', status);
      this.persist();
      return true;
    }
    if (status === 429 || status === 503) {
      this.fail(status === 429 ? 'rate-limited' : 'unavailable',
        retryDelay(response.headers, this.now(), 60000), status);
      return true;
    }
    return false;
  }
  private fail(kind: GeocodeFailure, pauseMs: number, status?: number): null {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + pauseMs);
    this.deps.report(kind, status);
    this.persist();
    return null;
  }
  private remember(key: string, result: string | null): string | null {
    this.cache.set(key, { name: result, expiresAt: result === null ? this.now() + DAY : null });
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    this.persist();
    return result;
  }
  private async load(): Promise<void> {
    try {
      const raw = await this.deps.storage.read();
      if (raw === null) return;
      if (raw.length > 2 * 1024 * 1024) throw new Error('Cache too large');
      const data: unknown = JSON.parse(raw);
      if (!record(data) || data.version !== 1 || data.format !== CACHE_FORMAT || !Array.isArray(data.entries)) {
        throw new Error('Invalid cache');
      }
      for (const entry of data.entries.slice(-CACHE_LIMIT)) {
        if (!record(entry) || typeof entry.key !== 'string' || !validKey(entry.key)) continue;
        const storedName = name(entry.name);
        const expiresAt = entry.expiresAt;
        if (entry.name !== null && !storedName) continue;
        if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= this.now())) continue;
        if (entry.name === null && expiresAt === null) continue;
        this.cache.set(entry.key, { name: storedName, expiresAt: expiresAt as number | null });
      }
      for (const field of ['cooldownUntil', 'blockedUntil', 'nextRequestAt'] as const) {
        const value = data[field];
        if (typeof value === 'number' && Number.isFinite(value) && value > this.now()) this[field] = value;
      }
    } catch {
      this.deps.report('cache-read');
    }
  }
  /** Serial writes never share the settings saveData() path or overwrite notes. */
  private persist(): void {
    this.writes = this.writes.then(async () => {
      const entries = Array.from(this.cache, ([key, entry]) => ({ key, ...entry }));
      await this.deps.storage.write(JSON.stringify({ version: 1, format: CACHE_FORMAT, entries,
        cooldownUntil: this.cooldownUntil, blockedUntil: this.blockedUntil, nextRequestAt: this.nextRequestAt }));
    }).catch(() => { this.deps.report('cache-write'); });
  }
}
