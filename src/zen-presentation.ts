/** Desktop Zen presentation: bundled basemap and interruptible, compositor-only motion. */
import { LAND_PATH } from './land-data';
import { buildSites, clusterSites, CLUSTER_RADIUS_PX, dotRadius, pickCenterLon, projectX,
  VIEW_H, VIEW_TOP, WORLD_W } from './map-view';

export interface ZenLocation { latitude: number; longitude: number }
export const ZEN_TRANSITION_MS = 400;
export const ZEN_DRIFT_PX_PER_SECOND = 2;
const SVG_NS = 'http://www.w3.org/2000/svg';
let nextPatternId = 0;

/** Same projection, clustering, radii and initial longitude as the Locations tab. */
export function zenMapLayout(locations: readonly ZenLocation[], width: number, height: number) {
  const safeHeight = Math.max(1, height);
  const unitPerPx = VIEW_H / safeHeight;
  const clusters = clusterSites(buildSites([...locations], item => item), CLUSTER_RADIUS_PX * unitPerPx);
  const viewWidth = Math.max(1, width) * unitPerPx;
  return { clusters, unitPerPx, left: projectX(pickCenterLon(clusters)) - viewWidth / 2, viewWidth };
}

/** A decorative layer only: no tooltip, text labels, event handlers, geolocation or network. */
export class ZenBackdrop {
  private readonly layer: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly observer: ResizeObserver | null;
  private readonly patternId = `jp-zen-world-${nextPatternId++}`;
  private locations: readonly ZenLocation[] = [];
  private active = false;
  private disposed = false;
  private motion: Animation | null = null;
  private motionDuration = 0;
  private inView = true;
  private readonly intersectionObserver: IntersectionObserver | null;
  private readonly reducedMotion: MediaQueryList | null;

  /** Pause rather than discard the phase, including when the app is occluded. */
  private readonly syncMotion = () => {
    if (!this.motion) return;
    const rect = this.root.getBoundingClientRect();
    const playing = this.active && !this.disposed && this.inView && rect.width > 0 && rect.height > 0
      && this.root.ownerDocument.visibilityState !== 'hidden' && !this.reducedMotion?.matches;
    if (playing) this.motion.play(); else this.motion.pause();
  };

  constructor(private readonly root: HTMLElement) {
    const doc = root.ownerDocument;
    this.layer = doc.createElement('div');
    this.layer.className = 'jp-zen-backdrop';
    this.layer.setAttribute('aria-hidden', 'true');
    this.svg = doc.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('focusable', 'false');
    this.layer.appendChild(this.svg);
    root.appendChild(this.layer);
    this.reducedMotion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    this.reducedMotion?.addEventListener?.('change', this.syncMotion);
    doc.addEventListener('visibilitychange', this.syncMotion);
    this.intersectionObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      this.inView = entries.some(entry => entry.target === root && entry.isIntersecting);
      this.syncMotion();
    });
    this.intersectionObserver?.observe(root);
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (this.active) this.draw();
    });
    this.observer?.observe(root);
  }

  setActive(active: boolean) { this.active = active; if (active) this.draw(); this.syncMotion(); }
  setLocations(locations: readonly ZenLocation[]) { this.locations = locations; if (this.active) this.draw(); }
  dispose() {
    this.disposed = true;
    this.motion?.cancel(); this.motion = null;
    this.observer?.disconnect(); this.intersectionObserver?.disconnect();
    this.reducedMotion?.removeEventListener?.('change', this.syncMotion);
    this.root.ownerDocument.removeEventListener('visibilitychange', this.syncMotion);
    this.layer.remove();
  }

  private draw() {
    if (this.disposed) return;
    const { width, height } = this.root.getBoundingClientRect();
    if (width <= 0 || height <= 0) { this.syncMotion(); return; }
    const { clusters, unitPerPx, left, viewWidth } = zenMapLayout(this.locations, width, height);
    const node = (tag: string, attrs: Record<string, string>, parent: SVGElement): SVGElement => {
      const el = this.root.ownerDocument.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      parent.appendChild(el);
      return el;
    };
    // One extra world provides a seamless horizontal repeat. Translate the SVG
    // as a composited layer instead of repainting geography on every frame.
    const worldPx = WORLD_W / unitPerPx;
    const phase = this.motionDuration > 0 ? (Number(this.motion?.currentTime ?? 0) % this.motionDuration) / this.motionDuration : 0;
    this.motion?.cancel(); this.motion = null;
    this.svg.replaceChildren();
    this.svg.style.width = `${width + worldPx}px`;
    this.svg.setAttribute('viewBox', `${left} ${VIEW_TOP} ${viewWidth + WORLD_W} ${VIEW_H}`);
    const defs = node('defs', {}, this.svg);
    // Pattern tiling preserves longitude wrapping even in very wide, short panes.
    const pattern = node('pattern', { id: this.patternId, x: '0', y: String(VIEW_TOP),
      width: String(WORLD_W), height: String(VIEW_H), patternUnits: 'userSpaceOnUse',
      viewBox: `0 ${VIEW_TOP} ${WORLD_W} ${VIEW_H}` }, defs);
    node('path', { d: LAND_PATH, class: 'jp-zen-land' }, pattern);
    for (const cluster of clusters) node('circle', { class: 'jp-zen-dot',
      cx: String(cluster.x), cy: String(cluster.y), r: String(dotRadius(cluster.count) * unitPerPx) }, pattern);
    node('rect', { x: String(left), y: String(VIEW_TOP), width: String(viewWidth + WORLD_W), height: String(VIEW_H),
      fill: `url(#${this.patternId})` }, this.svg);
    if (typeof this.svg.animate === 'function') {
      this.motionDuration = worldPx / ZEN_DRIFT_PX_PER_SECOND * 1000;
      this.motion = this.svg.animate([{ transform: 'translateX(0px)' }, { transform: `translateX(${-worldPx}px)` }],
        { duration: this.motionDuration, iterations: Infinity, easing: 'linear' });
      this.motion.pause();
      this.motion.currentTime = phase * this.motionDuration;
      this.syncMotion();
    }
  }
}

/** FLIP the live card, not a clone. Reversals start at its currently painted position. */
export function runZenTransition(root: HTMLElement, card: HTMLElement, chrome: HTMLElement[], enabled: boolean,
  update: () => void, previous: (() => void) | null): () => void {
  const win = card.ownerDocument.defaultView;
  const reduced = win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof card.animate !== 'function') {
    previous?.(); update(); return () => {};
  }
  const before = card.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const old = chrome.map(el => {
    const style = win.getComputedStyle(el);
    return { el, rect: el.getBoundingClientRect(), display: style.display,
      opacity: style.display === 'none' ? 0 : Number(style.opacity) };
  });
  previous?.();
  update();
  if (before.width <= 0 || rootRect.height <= 0) return () => {};
  const animations: Animation[] = [];
  const restore: Array<() => void> = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    animations.forEach(a => a.cancel());
    restore.forEach(fn => fn());
    card.classList.remove('jp-zen-moving');
  };
  const options: KeyframeAnimationOptions = { duration: ZEN_TRANSITION_MS, easing: 'cubic-bezier(.2,.7,.2,1)' };
  try {
    for (const state of old) {
      const { el, rect, opacity, display } = state;
      const styleBefore = el.getAttribute('style');
      const inertBefore = el.inert;
      restore.push(() => { if (styleBefore === null) el.removeAttribute('style'); else el.setAttribute('style', styleBefore); el.inert = inertBefore; });
      el.inert = true;
      if (enabled) {
        if (display === 'none' || rect.width <= 0) continue;
        el.setCssStyles({ position: 'absolute', boxSizing: 'border-box', margin: '0', pointerEvents: 'none' });
        el.style.setProperty('display', display, 'important');
        const parent = el.offsetParent as HTMLElement | null;
        const origin = parent?.getBoundingClientRect() ?? rootRect;
        el.style.setProperty('left', `${rect.left - origin.left + (parent?.scrollLeft ?? 0)}px`);
        el.style.setProperty('top', `${rect.top - origin.top + (parent?.scrollTop ?? 0)}px`);
        el.style.setProperty('width', `${rect.width}px`);
        el.style.setProperty('height', `${rect.height}px`);
      }
      animations.push(el.animate([{ opacity }, { opacity: enabled ? 0 : 1 }], options));
    }
    const after = card.getBoundingClientRect();
    card.classList.add('jp-zen-moving');
    animations.push(card.animate([{ transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` },
      { transform: 'translate(0px, 0px)' }], options));
    void Promise.all(animations.map(a => a.finished.catch(() => {}))).then(cleanup);
  } catch (err) {
    console.warn('[Spark Memo] Zen transition skipped', err);
    cleanup();
  }
  return cleanup;
}
