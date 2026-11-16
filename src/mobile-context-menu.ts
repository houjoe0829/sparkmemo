/** Each plugin keeps its own copy so its bundle remains independently installable. */
export interface ContextMenu {
  hide(): void;
  onHide(callback: () => void): unknown;
  dom?: HTMLElement;
}
const owners = new WeakMap<Document, () => void>();
export function closeMobileMenu(doc: Document): void { owners.get(doc)?.(); }

/** Keep ownership visible until dismissal, and consume an outside gesture through release. */
export function guardMobileMenu(menu: ContextMenu, source: HTMLElement, className: string,
  onClose: () => void = () => {}, menuElement?: HTMLElement): () => void {
  const doc = source.ownerDocument, win = doc.defaultView || window;
  owners.get(doc)?.();
  let open = true, swallowing = false, released = false, detached = false;
  let releaseTimer: number | undefined;
  const options = { capture: true, passive: false };
  const downEvents = ['pointerdown', 'touchstart', 'mousedown'];
  const followEvents = ['pointerup', 'touchend', 'mouseup', 'pointercancel', 'touchcancel', 'click'];
  const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const detach = () => {
    if (detached) return;
    detached = true;
    win.clearTimeout(releaseTimer);
    downEvents.forEach(type => win.removeEventListener(type, down, true));
    followEvents.forEach(type => win.removeEventListener(type, follow, true));
    win.removeEventListener('blur', dismiss);
  };
  const down = (event: Event) => {
    if (swallowing && released && event.type !== 'mousedown') { detach(); return; }
    if (swallowing) { block(event); return; }
    const element = menuElement || menu.dom || doc.body.querySelector<HTMLElement>('.menu:last-of-type');
    if (event.target instanceof win.Node && element?.contains(event.target)) return;
    swallowing = true;
    block(event);
    menu.hide();
  };
  const follow = (event: Event) => {
    if (!swallowing) return;
    block(event);
    if (!released && /up|end|cancel/.test(event.type)) {
      released = true;
      // Never expire while the finger is still held outside the menu.
      releaseTimer = win.setTimeout(detach, 800);
    }
    if (event.type === 'click') detach();
  };
  const dismiss = () => { menu.hide(); detach(); };
  const observer = new win.MutationObserver(() => { if (!source.isConnected) dismiss(); });
  const clear = () => {
    if (!open) return;
    open = false;
    observer.disconnect();
    source.classList.remove(className);
    if (owners.get(doc) === dismiss) owners.delete(doc);
    if (!swallowing) detach();
    onClose();
  };
  source.classList.add(className);
  owners.set(doc, dismiss);
  observer.observe(doc.body, { childList: true, subtree: true });
  // Obsidian has a single onHide callback slot. Keep all close work in this callback.
  menu.onHide(clear);
  downEvents.forEach(type => win.addEventListener(type, down, options));
  followEvents.forEach(type => win.addEventListener(type, follow, options));
  win.addEventListener('blur', dismiss);
  return dismiss;
}

/** Hold for 500 ms, preserve controls and scrolling, consume the opening gesture's click. */
export function bindMobileMenu(source: HTMLElement, options: {
  mobile: boolean; className: string; open(event: MouseEvent): ContextMenu | void;
  highlight?: HTMLElement; start?(): void; end?(): void; handled?(): void;
}): () => void {
  const doc = source.ownerDocument, win = doc.defaultView || window;
  // iOS can cancel its pointer stream while a finger is still held. Follow the
  // actual touch lifecycle there, rather than treating pointercancel as a release.
  const touchInput = 'ontouchstart' in win;
  const downEvent = touchInput ? 'touchstart' : 'pointerdown';
  const moveEvent = touchInput ? 'touchmove' : 'pointermove';
  const upEvent = touchInput ? 'touchend' : 'pointerup';
  const cancelEvent = touchInput ? 'touchcancel' : 'pointercancel';
  const globalEvents = [downEvent, moveEvent, upEvent, cancelEvent, 'scroll', 'dragstart', 'click', 'blur', 'keydown'];
  let timer: number | undefined, releaseTimer: number | undefined;
  let press: { id: number; x: number; y: number } | null = null;
  let handled = false, moved = false, suppress = false, synthetic = false, menuOpen = false, started = false;
  let dismiss: (() => void) | undefined;
  const stopHold = () => { win.clearTimeout(timer); timer = undefined; press = null; };
  const end = () => { if (started && !menuOpen) { started = false; options.end?.(); } };
  const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const detach = () => {
    win.clearTimeout(releaseTimer);
    for (const type of globalEvents)
      win.removeEventListener(type, globalEvent, true);
    observer.disconnect();
  };
  const cancel = (consume = false) => { stopHold(); suppress ||= consume; end(); };
  const excluded = (target: EventTarget | null) => target instanceof win.Element &&
    !!target.closest('a, button, input, textarea, select, audio, video, img, .jp-image-grid, [role="button"], [contenteditable="true"]');
  const observer = new win.MutationObserver(() => {
    if (!source.isConnected) { cancel(); dismiss?.(); detach(); }
  });
  const globalEvent = (event: Event) => {
    const pointer = event as PointerEvent;
    if (event.type === downEvent) {
      const secondary = touchInput ? (event as TouchEvent).touches.length > 1 : pointer.isPrimary === false;
      if (secondary) moved = true;
      cancel(!!press);
      if (!secondary) { suppress = false; handled = moved = false; detach(); }
    } else if (event.type === moveEvent && press) {
      const point = touchInput
        ? Array.from((event as TouchEvent).changedTouches).find(touch => touch.identifier === press?.id)
        : pointer.pointerId === press.id ? pointer : undefined;
      if (!point) return;
      if (handled) block(event);
      else if (Math.hypot(point.clientX - press.x, point.clientY - press.y) > 8) { moved = true; cancel(true); }
    } else if (event.type === upEvent && press && (touchInput
      ? Array.from((event as TouchEvent).changedTouches).some(touch => touch.identifier === press?.id)
      : pointer.pointerId === press.id)) {
      if (handled) event.preventDefault();
      stopHold(); end();
      releaseTimer = win.setTimeout(detach, 800);
    } else if (event.type === 'keydown') {
      stopHold(); suppress = false; end(); detach();
    } else if (event.type === 'click') {
      if (suppress) block(event);
      suppress = false; detach();
    } else if (event.type === 'dragstart') {
      if (handled) block(event); else { moved = true; cancel(true); }
    } else if ([cancelEvent, 'scroll', 'blur'].includes(event.type)) { moved = true; cancel(true); if (event.type === 'blur') detach(); }
  };
  const show = (event: MouseEvent) => {
    if (event.defaultPrevented || excluded(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    if (options.mobile && !synthetic && (handled || moved)) return;
    if (options.mobile) { handled = suppress = true; options.handled?.(); }
    win.clearTimeout(timer); timer = undefined;
    const menu = options.open(event);
    if (options.mobile && menu) {
      menuOpen = true;
      dismiss = guardMobileMenu(menu, options.highlight || source, options.className, () => { menuOpen = false; end(); });
    }
  };
  const down = (event: TouchEvent | PointerEvent) => {
    if (!options.mobile || excluded(event.target)) return;
    let id: number, x: number, y: number;
    if (touchInput) {
      const touches = (event as TouchEvent).touches;
      if (touches.length !== 1) return;
      const touch = touches[0];
      id = touch.identifier; x = touch.clientX; y = touch.clientY;
    } else {
      const pointer = event as PointerEvent;
      if (!['touch', 'pen'].includes(pointer.pointerType) || pointer.isPrimary === false || pointer.button !== 0) return;
      id = pointer.pointerId; x = pointer.clientX; y = pointer.clientY;
    }
    stopHold(); detach(); handled = moved = suppress = false;
    press = { id, x, y };
    started = true; options.start?.();
    for (const type of globalEvents)
      win.addEventListener(type, globalEvent, { capture: true, passive: false });
    observer.observe(doc.body, { childList: true, subtree: true });
    const pressedAt = Date.now();
    timer = win.setTimeout(() => {
      timer = undefined;
      if (!press || !source.isConnected || Date.now() - pressedAt > 750) { cancel(); return; }
      synthetic = true;
      source.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: press.x, clientY: press.y }));
      synthetic = false;
    }, 500);
  };
  source.addEventListener(downEvent, down, { passive: true });
  source.addEventListener('contextmenu', show);
  return () => { stopHold(); dismiss?.(); menuOpen = false; end(); detach(); source.removeEventListener(downEvent, down); source.removeEventListener('contextmenu', show); };
}
