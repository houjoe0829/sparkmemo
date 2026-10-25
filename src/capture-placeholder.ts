/** Decorative input hints. Timing follows Remix Desk, without touching input values. */
export const CAPTURE_PLACEHOLDER_TIMING = { typeMs: 42, deleteMs: 22, holdMs: 1900, pauseMs: 320 } as const;
export interface PlaceholderState { index: number; count: number; phase: 'typing' | 'holding' | 'deleting' | 'pausing' }
export const initialPlaceholderState = (index = 0): PlaceholderState => ({ index, count: 0, phase: 'typing' });

/** Pure state machine; a single timeout applies the returned state after its delay. */
export function advancePlaceholder(state: PlaceholderState, length: number, poolSize: number, reduced = false): { state: PlaceholderState; delay: number } {
  const timing = CAPTURE_PLACEHOLDER_TIMING;
  if (poolSize <= 0) return { state, delay: timing.holdMs };
  if (reduced) return { state: { index: (state.index + 1) % poolSize, count: length, phase: 'holding' }, delay: timing.holdMs };
  switch (state.phase) {
    case 'typing': return state.count < length
      ? { state: { ...state, count: state.count + 1 }, delay: timing.typeMs }
      : { state: { ...state, phase: 'holding' }, delay: timing.holdMs };
    case 'holding': return { state: { ...state, phase: 'deleting' }, delay: timing.deleteMs };
    case 'deleting': return state.count > 0
      ? { state: { ...state, count: state.count - 1 }, delay: timing.deleteMs }
      : { state: { ...state, phase: 'pausing' }, delay: timing.pauseMs };
    case 'pausing': return { state: initialPlaceholderState((state.index + 1) % poolSize), delay: timing.typeMs };
  }
}

/** An aria-hidden overlay keeps partial words out of the textarea and accessible name. */
export class CapturePlaceholder {
  private readonly layer: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private readonly query: MediaQueryList | null;
  private readonly intersection: IntersectionObserver | null;
  private readonly win: Window;
  private timer: number | null = null;
  private state = initialPlaceholderState();
  private pool: string[] = [];
  private inView = true;
  private composing = false;
  private disposed = false;
  private dirty = false;
  private readonly listeners: Array<[string, EventListener]> = [];

  constructor(private readonly textarea: HTMLTextAreaElement, wrapper: HTMLElement,
    private readonly phrases: () => string[], private readonly allowed: () => boolean = () => true) {
    const doc = textarea.ownerDocument;
    this.win = doc.defaultView!;
    this.layer = doc.createElement('div');
    this.layer.className = 'jp-capture-placeholder';
    this.layer.setAttribute('aria-hidden', 'true');
    this.text = doc.createElement('span');
    this.layer.appendChild(this.text);
    const caret = doc.createElement('span'); caret.className = 'jp-capture-placeholder-caret';
    this.layer.appendChild(caret); wrapper.appendChild(this.layer);
    textarea.classList.add('jp-capture-placeholder-managed');
    this.query = this.win.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    this.query?.addEventListener?.('change', this.sync);
    doc.addEventListener('visibilitychange', this.sync);
    for (const event of ['focus', 'blur', 'input', 'compositionstart', 'compositionend']) {
      const fn = () => {
        if (event === 'compositionstart') this.composing = true;
        if (event === 'compositionend') this.composing = false;
        this.sync();
      };
      textarea.addEventListener(event, fn); this.listeners.push([event, fn]);
    }
    this.intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      this.inView = entries.some(entry => entry.target === textarea && entry.isIntersecting);
      this.sync();
    });
    this.intersection?.observe(textarea);
    this.reset();
  }

  /** Called when existing save/cancel logic chooses another localized starting hint. */
  reset() {
    this.stop();
    this.pool = this.phrases().filter(Boolean);
    this.state = initialPlaceholderState(Math.max(0, this.pool.indexOf(this.textarea.placeholder)));
    this.sync();
  }

  readonly sync = () => {
    if (this.disposed) return;
    const pool = this.phrases().filter(Boolean);
    if (pool.join('\n') !== this.pool.join('\n')) {
      this.stop(); this.pool = pool; this.state = initialPlaceholderState();
    }
    if (this.textarea.value.length > 0) {
      this.dirty = true; this.state = initialPlaceholderState(this.state.index);
    } else if (this.dirty) { this.dirty = false; this.state = initialPlaceholderState(this.state.index); }
    const rect = this.textarea.getBoundingClientRect();
    const visible = this.pool.length > 0 && !this.textarea.value && !this.composing && this.allowed()
      && this.textarea.ownerDocument.activeElement !== this.textarea && this.inView
      && this.textarea.ownerDocument.visibilityState !== 'hidden' && rect.width > 0 && rect.height > 0;
    this.layer.hidden = !visible;
    if (!visible) { this.stop(); return; }
    const phrase = this.pool[this.state.index % this.pool.length];
    // The native placeholder remains a whole sentence for assistive technologies.
    this.textarea.placeholder = phrase;
    const characters = Array.from(phrase);
    this.text.textContent = this.query?.matches ? phrase : characters.slice(0, this.state.count).join('');
    if (this.timer !== null) return;
    const next = advancePlaceholder(this.state, characters.length, this.pool.length, this.query?.matches);
    this.timer = this.win.setTimeout(() => {
      this.timer = null; this.state = next.state; this.sync();
    }, next.delay);
  };

  dispose() {
    this.disposed = true; this.stop(); this.intersection?.disconnect();
    this.query?.removeEventListener?.('change', this.sync);
    this.textarea.ownerDocument.removeEventListener('visibilitychange', this.sync);
    for (const [event, fn] of this.listeners) this.textarea.removeEventListener(event, fn);
    this.textarea.classList.remove('jp-capture-placeholder-managed'); this.layer.remove();
  }

  private stop() { if (this.timer !== null) this.win.clearTimeout(this.timer); this.timer = null; }
}
