/** A static decorative hint for each visit, without touching input values. */
export class CapturePlaceholder {
  private readonly layer: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private readonly intersection: IntersectionObserver | null;
  private pool: string[];
  private index: number;
  private inView: boolean | null = null;
  private composing = false;
  private disposed = false;
  private readonly listeners: Array<[string, EventListener]> = [];

  constructor(private readonly textarea: HTMLTextAreaElement, wrapper: HTMLElement,
    private readonly phrases: () => string[], private readonly allowed: () => boolean = () => true,
    visibilityRoot: HTMLElement = wrapper) {
    this.pool = phrases().filter(Boolean);
    // The view already picked the initial localized hint when creating the input.
    this.index = Math.max(0, this.pool.indexOf(textarea.placeholder));
    this.layer = wrapper.createDiv();
    this.layer.className = 'jp-capture-placeholder';
    this.layer.setAttribute('aria-hidden', 'true');
    this.text = this.layer.createSpan();
    textarea.classList.add('jp-capture-placeholder-managed');
    textarea.ownerDocument.addEventListener('visibilitychange', this.sync);
    for (const event of ['focus', 'blur', 'input', 'compositionstart', 'compositionend']) {
      const fn = () => {
        if (event === 'compositionstart') this.composing = true;
        if (event === 'compositionend') this.composing = false;
        this.sync();
      };
      textarea.addEventListener(event, fn); this.listeners.push([event, fn]);
    }
    this.intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      const entry = entries.find(entry => entry.target === visibilityRoot);
      if (!entry) return;
      const reentered = this.inView === false && entry.isIntersecting;
      this.inView = entry.isIntersecting;
      if (reentered) this.enter();
      else this.sync();
    });
    // Observe the panel, not the input: scrolling the composer offscreen is not a new visit.
    this.intersection?.observe(visibilityRoot);
    this.sync();
  }

  /** Only opening/revealing the panel or returning to Capture starts a new visit. */
  enter() {
    if (this.disposed) return;
    this.pool = this.phrases().filter(Boolean);
    this.index = this.pool.length ? Math.floor(Math.random() * this.pool.length) : 0;
    this.sync();
  }

  readonly sync = () => {
    if (this.disposed) return;
    // Keep the same hint key when the plugin language changes.
    this.pool = this.phrases().filter(Boolean);
    const phrase = this.pool.length ? this.pool[this.index % this.pool.length] : '';
    this.textarea.placeholder = phrase;
    this.text.textContent = phrase;
    const rect = this.textarea.getBoundingClientRect();
    this.layer.hidden = !phrase || !!this.textarea.value || this.composing || !this.allowed()
      || this.textarea.ownerDocument.activeElement === this.textarea || this.inView === false
      || this.textarea.ownerDocument.visibilityState === 'hidden' || rect.width <= 0 || rect.height <= 0;
  };

  dispose() {
    this.disposed = true; this.intersection?.disconnect();
    this.textarea.ownerDocument.removeEventListener('visibilitychange', this.sync);
    for (const [event, fn] of this.listeners) this.textarea.removeEventListener(event, fn);
    this.textarea.classList.remove('jp-capture-placeholder-managed'); this.layer.remove();
  }
}
