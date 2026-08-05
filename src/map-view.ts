/**
 * Offline map view for the location tab.
 *
 * Renders every geo-tagged memo onto a bundled world basemap (see
 * `land-data.ts`) as screen-space clusters. There is no zoom and no network
 * request: the vertical extent is fixed to latitudes 78N..60S and the map
 * scrolls horizontally, wrapping seamlessly because Web Mercator is periodic
 * in longitude.
 *
 * Everything here is Obsidian-free so the projection and clustering can be
 * reasoned about (and tested) on their own.
 */

import { WORLD_W, VIEW_TOP, VIEW_H } from './land-data';

/** Latitude band the viewBox covers — south of this is empty ocean and ice. */
export const LAT_TOP = 78;
export const LAT_BOTTOM = -60;

/**
 * Cluster radius in screen pixels.
 *
 * Dots carry no permanent label — the count only appears on hover — so they can
 * stay small, which in turn lets the clustering run finer than it could when
 * every dot had to be wide enough to hold four digits.
 */
export const CLUSTER_RADIUS_PX = 14;

/** Aspect ratio of the visible map, derived from the projected viewBox. */
export const WORLD_ASPECT = WORLD_W / VIEW_H;

/** A single distinct coordinate, carrying every memo recorded there. */
export interface MapSite<T> {
  latitude: number;
  longitude: number;
  items: T[];
}

/** A group of nearby sites, drawn as one dot. */
export interface MapCluster<T> {
  /** Centre in projected grid units (same space as `LAND_PATH`). */
  x: number;
  y: number;
  latitude: number;
  longitude: number;
  count: number;
  items: T[];
}

/** Project longitude to a grid x in [0, WORLD_W). */
export function projectX(longitude: number): number {
  return ((longitude + 180) / 360) * WORLD_W;
}

/**
 * Project latitude to a grid y. Clamped just outside the visible band so that
 * polar coordinates stay finite (Mercator diverges at the poles).
 */
export function projectY(latitude: number): number {
  const lat = Math.max(-85, Math.min(85, latitude));
  const merc = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return ((Math.PI - merc) / (2 * Math.PI)) * WORLD_W;
}

/** Group memos that share an exact coordinate into sites. */
export function buildSites<T>(
  items: T[],
  getCoord: (item: T) => { latitude: number; longitude: number } | null,
): Array<MapSite<T>> {
  const byCoord = new Map<string, MapSite<T>>();
  for (const item of items) {
    const c = getCoord(item);
    if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) continue;
    const key = `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`;
    let site = byCoord.get(key);
    if (!site) {
      site = { latitude: c.latitude, longitude: c.longitude, items: [] };
      byCoord.set(key, site);
    }
    site.items.push(item);
  }
  return [...byCoord.values()];
}

/**
 * Single-pass greedy clustering in screen space.
 *
 * Screen distance, not kilometres: the question is whether two dots would
 * visually collide, and Mercator stretches a given distance differently at
 * different latitudes. Because there is no zoom, one pass is enough — there is
 * never more than one clustering result alive at a time.
 *
 * Sites are seeded densest-first (ties broken by coordinate) so the result is
 * deterministic across renders.
 */
export function clusterSites<T>(sites: Array<MapSite<T>>, radiusUnits: number): Array<MapCluster<T>> {
  const pts = sites
    .map((s) => ({ site: s, x: projectX(s.longitude), y: projectY(s.latitude), taken: false }))
    .sort(
      (a, b) =>
        b.site.items.length - a.site.items.length ||
        a.site.latitude - b.site.latitude ||
        a.site.longitude - b.site.longitude,
    );

  const r2 = radiusUnits * radiusUnits;
  const out: Array<MapCluster<T>> = [];

  for (const seed of pts) {
    if (seed.taken) continue;
    seed.taken = true;
    const members = [seed];

    for (const other of pts) {
      if (other.taken) continue;
      const dx = other.x - seed.x;
      const dy = other.y - seed.y;
      if (dx * dx + dy * dy <= r2) {
        other.taken = true;
        members.push(other);
      }
    }

    // Weight by memo count so the dot lands where the records actually are.
    let wx = 0;
    let wy = 0;
    let wlat = 0;
    let wlon = 0;
    let count = 0;
    const items: T[] = [];
    for (const m of members) {
      const n = m.site.items.length;
      wx += m.x * n;
      wy += m.y * n;
      wlat += m.site.latitude * n;
      wlon += m.site.longitude * n;
      count += n;
      items.push(...m.site.items);
    }
    out.push({ x: wx / count, y: wy / count, latitude: wlat / count, longitude: wlon / count, count, items });
  }

  return out;
}

/** Smallest and largest dot, in screen pixels. */
export const DOT_MIN_R = 3.5;
export const DOT_MAX_R = 11;

/**
 * Dot radius in screen pixels.
 *
 * Logarithmic, not square-root: counts here span three orders of magnitude
 * (1 to over 1200), and under a square-root curve everything past a dozen memos
 * pins to the maximum and reads identically. Size is the only cue to magnitude
 * now that the number is hidden, so it has to stay legible across the range.
 */
export function dotRadius(count: number): number {
  return Math.max(DOT_MIN_R, Math.min(DOT_MAX_R, DOT_MIN_R + 2.3 * Math.log10(Math.max(1, count))));
}

/** Radius the hovered dot grows to — wide enough to hold a four-digit count. */
export function hoverRadius(count: number): number {
  return Math.max(15, dotRadius(count) * 1.6);
}

/**
 * Centre longitude implied by the machine's time zone, so the map opens
 * somewhere plausible without asking for location permission or going online.
 *
 * Uses the *standard* offset, not the current one: DST shifts the offset by a
 * full hour (15 degrees of longitude) and would otherwise make the same place
 * open differently in summer and winter.
 */
export function timezoneCenterLon(now: Date = new Date()): number {
  const y = now.getFullYear();
  const std = Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset());
  const lon = -std / 4;
  return Math.max(-180, Math.min(180, lon));
}

/**
 * Where to centre on open. The time zone answers "where am I", but the user
 * wants "where are my records" — so if nothing was recorded anywhere near the
 * time zone's longitude, fall back to the densest cluster instead.
 */
export function pickCenterLon<T>(clusters: Array<MapCluster<T>>, now?: Date): number {
  const tzLon = timezoneCenterLon(now);
  if (clusters.length === 0) return tzLon;

  const near = clusters.some((c) => {
    const d = Math.abs(((c.longitude - tzLon + 540) % 360) - 180);
    return d <= 40;
  });
  if (near) return tzLon;

  let best = clusters[0];
  for (const c of clusters) if (c.count > best.count) best = c;
  return best.longitude;
}

export { WORLD_W, VIEW_TOP, VIEW_H };
