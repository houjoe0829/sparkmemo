const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const Module = require('node:module');
const fs = require('node:fs');
const filename = require('node:path').resolve('src/capture-placeholder.ts');
const m = new Module(filename, module);
m._compile(buildSync({ entryPoints: [filename], bundle: true, write: false, format: 'cjs', platform: 'node' }).outputFiles[0].text, filename);
const { CapturePlaceholder } = m.exports;

function fixture({ pool = ['你好', '记下这一刻'], index = 0 } = {}) {
  let timerCalls = 0, observer;
  const events = new Map();
  const doc = { visibilityState: 'visible', activeElement: null,
    defaultView: { setTimeout() { timerCalls++; throw Error('Hints must not schedule timers'); } },
    addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) };
  function node() {
    const listeners = new Map(), classes = new Set();
    return { ownerDocument: doc, value: '', placeholder: pool[index], children: [], hidden: false, attrs: {},
      createDiv() { return this.appendChild(node()); }, createSpan() { return this.appendChild(node()); },
      classList: { add: key => classes.add(key), remove: key => classes.delete(key) },
      setAttribute(key, value) { this.attrs[key] = value; },
      appendChild(child) { this.children.push(child); return child; }, remove() { this.removed = true; },
      getBoundingClientRect: () => ({ width: 320, height: 65 }),
      addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key),
      fire(key) { if (key === 'focus') doc.activeElement = this; if (key === 'blur') doc.activeElement = null; listeners.get(key)?.(); }, listeners };
  }
  const previous = global.IntersectionObserver;
  global.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    visibility(isIntersecting) { this.callback([{ target: this.target, isIntersecting }]); }
  };
  const textarea = node(), wrapper = node(), panel = node();
  let allowed = true, controller;
  try { controller = new CapturePlaceholder(textarea, wrapper, () => pool, () => allowed, panel); }
  finally { global.IntersectionObserver = previous; }
  return { controller, textarea, panel, observer, layer: wrapper.children[0], doc, events,
    timers: () => timerCalls, setPool: value => pool = value, setAllowed: value => allowed = value };
}
function withRandom(value, fn) {
  const previous = Math.random;
  Math.random = () => value;
  try { return fn(); } finally { Math.random = previous; }
}

test('initial hint is a complete static sentence with no decorative caret or timers', () => {
  const f = fixture({ index: 1 });
  assert.equal(f.layer.attrs['aria-hidden'], 'true');
  assert.equal(f.layer.children.length, 1);
  assert.equal(f.layer.children[0].textContent, '记下这一刻');
  assert.equal(f.textarea.placeholder, '记下这一刻'); assert.equal(f.textarea.value, '');
  for (let i = 0; i < 1000; i++) f.controller.sync();
  assert.equal(f.layer.children[0].textContent, '记下这一刻'); assert.equal(f.timers(), 0);
  f.controller.dispose();
});
test('only explicit entry picks a random hint, and repeats are allowed', () => {
  const f = fixture();
  withRandom(0.99, () => f.controller.enter()); assert.equal(f.textarea.placeholder, '记下这一刻');
  withRandom(0, () => f.controller.sync()); assert.equal(f.textarea.placeholder, '记下这一刻');
  withRandom(0.99, () => f.controller.enter()); assert.equal(f.textarea.placeholder, '记下这一刻');
  withRandom(0, () => f.controller.enter()); assert.equal(f.textarea.placeholder, '你好');
  f.controller.dispose();
});
test('focus, IME, input and clearing after save preserve the chosen hint and user text', () => {
  const f = fixture();
  f.textarea.fire('focus'); assert.equal(f.layer.hidden, true);
  f.textarea.fire('compositionstart'); f.textarea.value = '中文草稿';
  f.textarea.fire('input'); f.textarea.fire('compositionend'); f.textarea.fire('blur');
  assert.equal(f.textarea.value, '中文草稿'); assert.equal(f.layer.hidden, true);
  f.textarea.value = ''; f.textarea.fire('input');
  assert.equal(f.layer.hidden, false); assert.equal(f.textarea.placeholder, '你好');
  assert.equal(f.layer.children[0].textContent, '你好'); f.controller.dispose();
});
test('editing, submission, application visibility and zero-size input do not pick new hints', () => {
  const f = fixture();
  withRandom(0.99, () => {
    f.setAllowed(false); f.controller.sync(); assert.equal(f.layer.hidden, true);
    f.setAllowed(true); f.controller.sync(); assert.equal(f.layer.hidden, false);
    f.doc.visibilityState = 'hidden'; f.events.get('visibilitychange')(); assert.equal(f.layer.hidden, true);
    f.doc.visibilityState = 'visible'; f.events.get('visibilitychange')(); assert.equal(f.layer.hidden, false);
    f.textarea.getBoundingClientRect = () => ({ width: 0, height: 0 }); f.controller.sync();
    assert.equal(f.layer.hidden, true);
    f.textarea.getBoundingClientRect = () => ({ width: 320, height: 65 }); f.controller.sync();
    assert.equal(f.layer.hidden, false); assert.equal(f.textarea.placeholder, '你好');
  }); f.controller.dispose();
});
test('panel hide/reveal starts a new visit, but initial and repeated intersection notifications do not', () => {
  const f = fixture(); assert.equal(f.observer.target, f.panel);
  withRandom(0.99, () => {
    f.observer.visibility(true); assert.equal(f.textarea.placeholder, '你好');
    f.observer.visibility(true); assert.equal(f.textarea.placeholder, '你好');
    f.observer.visibility(false); assert.equal(f.layer.hidden, true);
    f.observer.visibility(true); assert.equal(f.textarea.placeholder, '记下这一刻');
  });
  withRandom(0, () => { f.observer.visibility(true); assert.equal(f.textarea.placeholder, '记下这一刻'); });
  f.controller.dispose();
});
test('language changes preserve the chosen index and emoji/empty pools are safe', () => {
  const f = fixture({ pool: ['😀你好', '再见'], index: 1 });
  f.setPool(['Hello', 'Bye']); f.controller.sync(); assert.equal(f.textarea.placeholder, 'Bye');
  f.setPool([]); f.controller.sync(); assert.equal(f.layer.hidden, true); assert.equal(f.textarea.placeholder, '');
  f.controller.enter(); assert.equal(f.layer.hidden, true);
  f.setPool(['😀你好']); f.controller.sync(); assert.equal(f.layer.children[0].textContent, '😀你好');
  f.controller.dispose();
});
test('closing removes all listeners and observer; disposed controllers do nothing', () => {
  const f = fixture(); f.controller.dispose();
  assert.equal(f.textarea.listeners.size, 0); assert.equal(f.events.size, 0);
  assert.equal(f.observer.disconnected, true); assert.equal(f.layer.removed, true);
  const old = f.textarea.placeholder; f.setPool(['Other']); f.controller.enter(); f.controller.sync();
  assert.equal(f.textarea.placeholder, old);
});
test('decorative hint CSS contains no blinking caret animation', () => {
  const css = fs.readFileSync('styles.css', 'utf8');
  assert.doesNotMatch(css, /jp-placeholder-caret|jp-capture-placeholder-caret/);
});
