// Run with node --test scripts/capture-navigation.test.cjs. No vault writes or live UI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');
const moment = require('moment');

class Element {
  constructor(options = {}) { this.children = []; this.text = options.text || ''; this.cls = options.cls || ''; this.attrs = options.attr || {}; this.events = {}; }
  createDiv(options) { return this.appendChild(new Element(options)); }
  createEl(tag, options) { return this.createDiv(options); }
  createSpan(options) { return this.createDiv(options); }
  appendChild(child) { this.children.push(child); return child; }
  empty() { this.children = []; }
  addEventListener(event, callback) { this.events[event] = callback; }
  toggleClass() {}
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}
const filename = path.resolve(__dirname, '../src/capture-view.ts');
const output = buildSync({ entryPoints: [filename], bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['obsidian', 'obsidian-daily-notes-interface', '@codemirror/*'], loader: { '.wasm': 'binary' },
  define: { __PLUGIN_VERSION__: '"test"', __BUILD_NUMBER__: '"test"' },
}).outputFiles[0].text;
const loaded = new Module(filename, module);
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
const obsidian = { Component: class {}, ItemView: class {}, Modal: class {}, FuzzySuggestModal: class {},
  TFile: class {}, TFolder: class {}, moment, getLanguage: () => 'en', setIcon: (element, name) => { element.icon = name; } };
const originalRequire = loaded.require.bind(loaded);
loaded.require = name => name === 'obsidian' ? obsidian : name === 'obsidian-daily-notes-interface'
  ? { appHasDailyNotesPluginLoaded: () => true } : originalRequire(name);
loaded._compile(output, filename);
const { JournalCaptureView } = loaded.exports;

for (const [description, offset, empty] of [
  ['today with entries', 0, false], ['historical day with entries', -2, false],
  ['empty historical day', -3, true], ['lookback boundary', -365, false],
]) {
  test(`capture rebuild has no bottom controls or empty navigation row: ${description}`, async () => {
    const view = Object.create(JournalCaptureView.prototype);
    view.timelineEl = new Element(); view.timelineScrollEl = { scrollTop: 200 };
    view.currentDate = moment().startOf('day').add(offset, 'days'); view.maxLookbackDays = 365;
    view.days = [];
    view.disposeDays = () => { view.days = []; };
    let navUpdates = 0; view.updateDayNavState = () => { navUpdates++; };
    const day = { el: new Element({ cls: 'jp-day-section', text: empty ? 'No memos on this day' : 'Memo contents' }) };
    view.buildDaySection = async (date, allowEmpty) => {
      assert.equal(date, view.currentDate); assert.equal(allowEmpty, true); return day;
    };
    await view.fullRebuild();
    assert.deepEqual(view.timelineEl.children, [day.el]); // No trailing empty row or spacer.
    assert.equal(view.timelineEl.descendants().some(el => el.cls.includes('jp-timeline-bottom-nav')), false);
    assert.ok(!view.timelineEl.textContent.includes('View previous day'));
    assert.ok(!view.timelineEl.textContent.includes('Back to today'));
    assert.equal(view.days[0], day); assert.equal(navUpdates, 1);
    assert.equal(view.timelineScrollEl.scrollTop, 0); assert.equal(view.exhausted, true);
  });
}

test('top previous/calendar/next controls retain navigation and calendar callbacks', () => {
  const view = Object.create(JournalCaptureView.prototype);
  const parent = new Element(); const actions = [];
  view.navigateDay = delta => actions.push(delta); view.openCalendarPicker = () => actions.push('calendar');
  view.buildDayNavControls(parent);
  assert.deepEqual(view.dayNavEl.children.map(el => el.attrs['aria-label']), ['Previous day', 'Pick a date', 'Next day']);
  assert.deepEqual(view.dayNavEl.children.map(el => el.icon), ['chevron-left', 'calendar', 'chevron-right']);
  view.dayNavEl.children.forEach(el => el.events.click());
  assert.deepEqual(actions, [-1, 'calendar', 1]);
});
