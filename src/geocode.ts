/**
 * Reverse geocoding via OpenStreetMap's Nominatim — turns a decimal-degree
 * GPS coordinate into a coarse, human-readable place name (city/district
 * level, not street/POI). Free, no API key, but rate-limited to ~1 req/s —
 * callers doing a photo batch should await sequentially, not in parallel.
 */

import { requestUrl } from 'obsidian';

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  country?: string;
}

interface NominatimResponse {
  address?: NominatimAddress;
}

/**
 * Resolves a coordinate to a coarse place name, preferring city-level
 * granularity and falling back to progressively broader administrative
 * levels. Returns `null` on any network/parse failure — callers should fall
 * back to storing the raw coordinate without a display name.
 */
export async function reverseGeocodeCity(latitude: number, longitude: number): Promise<string | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
      `&lat=${latitude}&lon=${longitude}&zoom=10&accept-language=zh-CN`;
    const res = await requestUrl({
      url,
      headers: { 'User-Agent': 'SparkMemo-Obsidian-Plugin' },
    });
    if (res.status !== 200) return null;

    const data = res.json as NominatimResponse;
    const address = data.address;
    if (!address) return null;
    return address.city ?? address.town ?? address.village ?? address.county ?? address.state ?? address.country ?? null;
  } catch {
    return null;
  }
}
