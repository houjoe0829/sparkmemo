/**
 * A CodeMirror 6 instance that stands in for the quick-capture box's plain
 * `<textarea>`, wearing just enough of the textarea API surface that the
 * surrounding call sites in `capture-view.ts` don't need to change: `.value`,
 * `.selectionStart`/`.selectionEnd`, `.setSelectionRange()`, `.focus()`,
 * `.placeholder`, `.style`/`.scrollHeight` (auto-resize), and
 * `.addEventListener`/`.dispatchEvent` for the handful of DOM events the
 * input box listens for.
 *
 * Why CM6 instead of the native `<textarea>`: a plain textarea can't render
 * mixed styling (bold/italic/faded syntax markers) within its text — that's
 * an HTML limitation, not a missing feature. CM6 is already an Obsidian
 * dependency (bundled externally, so this adds no bundle weight) and already
 * solves cursor mapping, undo history and IME composition, which a
 * hand-rolled `contentEditable` div would have to reimplement from scratch.
 *
 * `buildCaptureMarkdownDecorations` (see `section.ts`) treats line 1 as the
 * entry's own head line (inline formatting only) and every following line as
 * an indented continuation (headings/lists too), since that's how the text
 * typed here ends up once `buildEntryLine` prepends the `- HH:MM ` marker.
 */

import { Compartment, EditorState, Prec } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { buildCaptureMarkdownDecorations } from './section';

/**
 * List continuation on Enter — mirrors the equivalent logic in `main.ts`'s
 * `createEnterKeymap`, but the "does list syntax apply here" check is just
 * "not line 1" (see the module doc above) instead of a timestamp regex.
 * Handles: unordered marker repeats as-is, ordered marker increments by 1,
 * and an empty list item clears its marker and exits list mode instead of
 * repeating forever.
 */
const listContinuationKeymap = Prec.high(
  keymap.of([
    {
      key: 'Enter',
      run(view: EditorView): boolean {
        const state = view.state;
        const cursor = state.selection.main;
        const line = state.doc.lineAt(cursor.head);
        if (line.number < 2) return false; // head line — lists don't apply here

        const orderedMatch = line.text.match(/^(\s*)(\d+)(\.\s+)/);
        const unorderedMatch = line.text.match(/^(\s*)([-*+]\s+)/);
        if (!orderedMatch && !unorderedMatch) return false;

        const indent = (orderedMatch ?? unorderedMatch)![1];
        const marker = orderedMatch ? orderedMatch[2] + orderedMatch[3] : unorderedMatch![2];
        const restOfLine = line.text.slice(indent.length + marker.length);

        if (restOfLine.trim().length === 0) {
          // Empty list item — clear the marker and exit list mode instead of
          // repeating an empty prefix forever.
          view.dispatch({
            changes: { from: line.from, to: cursor.to, insert: '\n' },
            selection: { anchor: line.from + 1 },
            scrollIntoView: true,
          });
          return true;
        }

        const nextMarker = orderedMatch ? `${Number(orderedMatch[2]) + 1}. ` : marker;
        const insertion = '\n' + indent + nextMarker;
        view.dispatch({
          changes: { from: cursor.from, to: cursor.to, insert: insertion },
          selection: { anchor: cursor.from + insertion.length },
          scrollIntoView: true,
        });
        return true;
      },
    },
  ]),
);

export class CaptureEditor {
  readonly view: EditorView;

  private readonly inputListeners: Array<(...args: any[]) => void> = [];
  private readonly placeholderCompartment = new Compartment();
  private _placeholder = '';

  constructor(parent: HTMLElement, cls: string) {
    const markdownPlugin = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildCaptureMarkdownDecorations(view.state.doc.toString());
        }
        update(update: ViewUpdate) {
          if (update.docChanged) {
            this.decorations = buildCaptureMarkdownDecorations(update.state.doc.toString());
          }
        }
      },
      { decorations: v => v.decorations },
    );

    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '',
        extensions: [
          EditorView.lineWrapping,
          // CM6 recomputes and overwrites the editor root's whole `class`
          // attribute on internal reconciliations (e.g. toggling its own
          // `cm-focused` class on focus/blur) — a one-off `classList.add()`
          // after construction gets wiped out the next time that happens.
          // `editorAttributes` is the extension CM6 itself tracks, so the
          // class survives every reconciliation.
          EditorView.editorAttributes.of({ class: cls }),
          this.placeholderCompartment.of(placeholderExt('')),
          markdownPlugin,
          listContinuationKeymap,
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              for (const fn of this.inputListeners) fn();
            }
          }),
        ],
      }),
    });

    // Clicks in the visible-but-empty area below the last line of text land
    // on .cm-scroller (or .cm-editor) rather than on .cm-content, which
    // means the browser's own "click to focus + place caret" logic doesn't
    // fire — the outer box's focus-within ring lights up but the caret
    // never lands. Bridge that: if the click misses .cm-content, focus the
    // editor and put the caret at the very end of the doc, matching the
    // "click below text" behavior of a native <textarea>.
    this.view.dom.addEventListener('mousedown', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (this.view.contentDOM.contains(target)) return;
      e.preventDefault();
      const end = this.view.state.doc.length;
      this.view.focus();
      this.view.dispatch({ selection: { anchor: end } });
    });
  }

  // ── textarea-like API ─────────────────────────────────────────────────

  get value(): string {
    return this.view.state.doc.toString();
  }

  set value(text: string) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  get selectionStart(): number {
    return this.view.state.selection.main.from;
  }

  get selectionEnd(): number {
    return this.view.state.selection.main.to;
  }

  setSelectionRange(start: number, end: number): void {
    const len = this.view.state.doc.length;
    const clamp = (n: number) => Math.max(0, Math.min(n, len));
    this.view.dispatch({
      selection: { anchor: clamp(start), head: clamp(end) },
      scrollIntoView: true,
    });
  }

  focus(): void {
    this.view.focus();
  }

  get placeholder(): string {
    return this._placeholder;
  }

  set placeholder(text: string) {
    this._placeholder = text;
    this.view.dispatch({
      effects: this.placeholderCompartment.reconfigure(placeholderExt(text)),
    });
  }

  /** Proxies to the underlying DOM node so `.style.height`/`.scrollHeight`-based auto-resize keeps working unchanged. */
  get style(): CSSStyleDeclaration {
    return this.view.dom.style;
  }

  get scrollHeight(): number {
    return this.view.dom.scrollHeight;
  }

  get offsetLeft(): number {
    return this.view.dom.offsetLeft;
  }

  get offsetTop(): number {
    return this.view.dom.offsetTop;
  }

  get scrollTop(): number {
    return this.view.scrollDOM.scrollTop;
  }

  contains(node: Node | null): boolean {
    return node !== null && this.view.dom.contains(node);
  }

  /**
   * Pixel coordinates of `pos` relative to `relativeTo` (typically the
   * shared offsetParent of a suggestion popup) — replaces the mirror-div
   * caret-measurement hack the old textarea-based code needed, since CM6
   * can just answer this directly.
   */
  coordsRelativeTo(pos: number, relativeTo: HTMLElement): { left: number; top: number; bottom: number } | null {
    const coords = this.view.coordsAtPos(pos);
    if (!coords) return null;
    const base = relativeTo.getBoundingClientRect();
    return {
      left: coords.left - base.left,
      top: coords.top - base.top,
      bottom: coords.bottom - base.top,
    };
  }

  addEventListener(type: 'input', handler: () => void): void;
  addEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: string, handler: (e: any) => void, options?: boolean | AddEventListenerOptions): void {
    if (type === 'input') {
      this.inputListeners.push(handler);
      return;
    }
    this.view.contentDOM.addEventListener(type, handler, options);
  }

  dispatchEvent(event: Event): boolean {
    if (event.type === 'input') {
      for (const fn of this.inputListeners) fn();
      return true;
    }
    return this.view.contentDOM.dispatchEvent(event);
  }
}
