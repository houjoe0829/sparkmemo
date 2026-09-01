import { App, TFile, TFolder } from 'obsidian';

/**
 * A note or folder offered in the `@` dropdown. Folders are kept because Claude
 * resolves `@some/folder/` on its own — the reference does not have to name a
 * single file to be useful.
 */
type MentionItem =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'folder'; name: string; path: string };

const MAX_RESULTS = 30;
/** Kept in sync with `.jp-mention-dropdown`'s `max-height` in `styles.css`. */
const MAX_HEIGHT = 240;

export interface MentionSuggestCallbacks {
  /**
   * Called with the vault-relative path of every note the user picks, so the
   * caller can pass them along as note references. Folders are not reported:
   * a folder is not a note and has nothing to be recorded under.
   */
  onPickFile?: (path: string) => void;
}

/**
 * Mirrors the `@` mention dropdown in MyClaudian's composer, for the plain
 * textarea in "Send to MyClaudian".
 *
 * What travels to MyClaudian is only the inserted text — `@path/to/note.md` for
 * a note, `@path/to/folder/` for a folder — which is exactly what MyClaudian's
 * own composer writes. The receiving side already knows how to read those, so
 * nothing about the send path needs to change to support this.
 *
 * Deliberately a local copy rather than a shared module: the two plugins are
 * bundled separately, so there is no import to reach across. Only the two item
 * types that make sense here are kept — MyClaudian's MCP servers, agents, and
 * external context roots have no counterpart in Spark Memo.
 */
export class MentionSuggest {
  private app: App;
  private inputEl: HTMLTextAreaElement;
  private listEl: HTMLElement;
  private callbacks: MentionSuggestCallbacks;

  private items: MentionItem[] = [];
  private repositionFrame = 0;
  private selected = 0;
  /** Index of the `@` that opened the current query, or -1 when closed. */
  private startIndex = -1;

  constructor(
    app: App,
    inputEl: HTMLTextAreaElement,
    callbacks: MentionSuggestCallbacks = {},
  ) {
    this.app = app;
    this.inputEl = inputEl;
    this.callbacks = callbacks;

    // On `body` rather than inside the modal: the composer sits near the bottom
    // of a fixed-height dialog, so a list rendered in the modal's own flow is
    // clipped by its edge after two rows.
    this.listEl = document.body.createDiv({ cls: 'jp-mention-dropdown' });
    this.listEl.style.display = 'none';

    // On `document`, not on the textarea: listeners on the element the event
    // targets fire in registration order whatever their capture flag, so sitting
    // there would only beat the composer's own Enter-to-send by being built
    // first. Capturing from an ancestor genuinely runs earlier, which lets the
    // dropdown claim Enter no matter when it was attached.
    document.addEventListener('keydown', this.onKeyDown, true);
    this.inputEl.addEventListener('input', this.onInput);
    this.inputEl.addEventListener('blur', this.onBlur);
  }

  destroy(): void {
    window.cancelAnimationFrame(this.repositionFrame);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.inputEl.removeEventListener('input', this.onInput);
    this.inputEl.removeEventListener('blur', this.onBlur);
    this.listEl.remove();
  }

  get isOpen(): boolean {
    return this.startIndex >= 0;
  }

  private onInput = (): void => {
    this.refresh();
  };

  /**
   * Closing on blur is deferred: a click on a dropdown row blurs the textarea
   * before the click lands, and hiding immediately would remove the row from
   * under the pointer.
   */
  private onBlur = (): void => {
    window.setTimeout(() => this.close(), 150);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== this.inputEl) return;
    if (!this.isOpen || this.items.length === 0) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.move(-1);
        return;
      case 'Enter':
      case 'Tab':
        if (event.isComposing) return;
        event.preventDefault();
        // The composer sends on Enter, and that listener sits on this same
        // element, so stopping propagation is not enough.
        event.stopImmediatePropagation();
        this.pick(this.selected);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
        return;
      default:
        return;
    }
  };

  /**
   * Re-reads the text around the cursor and opens, updates, or closes the
   * dropdown accordingly.
   */
  private refresh(): void {
    const cursor = this.inputEl.selectionStart ?? 0;
    const text = this.inputEl.value;
    const at = this.findMentionStart(text, cursor);
    if (at < 0) {
      this.close();
      return;
    }

    this.startIndex = at;
    this.items = this.search(text.slice(at + 1, cursor));
    this.selected = 0;
    this.render();
  }

  /**
   * Index of the `@` the cursor is currently typing after, or -1. A mention only
   * starts at the beginning of the text or after whitespace, so email addresses
   * and the like do not open a dropdown, and any whitespace after the `@` ends
   * the query rather than searching across it.
   */
  private findMentionStart(text: string, cursor: number): number {
    for (let i = cursor - 1; i >= 0; i--) {
      const char = text[i];
      if (char === '@') {
        const before = i > 0 ? text[i - 1] : '';
        return before === '' || /\s/.test(before) ? i : -1;
      }
      if (/\s/.test(char)) return -1;
    }
    return -1;
  }

  /**
   * Ranking mirrors MyClaudian's, tier by tier, so the same keystrokes surface the
   * same note in both composers:
   *
   *   1. prefix matches first — typing the start of a name is an aim, not a filter
   *   2. notes already open in a tab
   *   3. notes before folders
   *   4. most recently modified
   *   5. path, only to keep the order stable when everything above ties
   *
   * With an empty query that collapses to "recently touched first", which is the
   * useful first screen; alphabetical order would put whatever starts with a digit
   * on top and nothing else.
   */
  private search(query: string): MentionItem[] {
    const needle = query.toLowerCase();
    const open = new Set(
      this.app.workspace.getLeavesOfType('markdown')
        .map(leaf => (leaf.view as { file?: TFile } | undefined)?.file?.path)
        .filter((path): path is string => Boolean(path)),
    );

    // A slash means the user is spelling out a location, so match the whole path.
    // Without one, match names only — otherwise typing a folder's name drags in
    // every note underneath it and buries the folder itself.
    const isPathQuery = needle.includes('/');
    const subject = (name: string, path: string): string =>
      (isPathQuery ? path : name).toLowerCase();

    type Scored = MentionItem & { mtime: number; isOpen: boolean; prefix: boolean };

    const files: Scored[] = this.app.vault.getMarkdownFiles()
      .filter(file => subject(file.basename, file.path).includes(needle))
      .map(file => ({
        kind: 'file' as const,
        name: file.basename,
        path: file.path,
        mtime: file.stat.mtime,
        isOpen: open.has(file.path),
        prefix: subject(file.basename, file.path).startsWith(needle),
      }));

    // A folder has no modification time of its own, so it borrows the newest one
    // inside it. Without this every folder would sort as "never touched" and land
    // below every note, which is the same as not offering folders at all.
    const folderMtime = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const parts = file.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const path = parts.slice(0, i).join('/');
        if ((folderMtime.get(path) ?? 0) < file.stat.mtime) {
          folderMtime.set(path, file.stat.mtime);
        }
      }
    }

    const folders: Scored[] = [];
    const walk = (folder: TFolder): void => {
      for (const child of folder.children) {
        if (!(child instanceof TFolder)) continue;
        if (subject(child.name, child.path).includes(needle)) {
          folders.push({
            kind: 'folder',
            name: child.name,
            path: child.path,
            mtime: folderMtime.get(child.path) ?? 0,
            isOpen: false,
            prefix: subject(child.name, child.path).startsWith(needle),
          });
        }
        walk(child);
      }
    };
    walk(this.app.vault.getRoot());

    return [...files, ...folders]
      .sort((a, b) => {
        if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
        if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
        if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1;
        if (a.mtime !== b.mtime) return b.mtime - a.mtime;
        return a.path.localeCompare(b.path);
      })
      .slice(0, MAX_RESULTS)
      .map(({ kind, name, path }) => ({ kind, name, path } as MentionItem));
  }

  private move(delta: number): void {
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.render();
  }

  private render(): void {
    this.listEl.empty();
    if (this.items.length === 0) {
      this.close();
      return;
    }

    this.items.forEach((item, index) => {
      const row = this.listEl.createDiv({
        cls: `jp-mention-item${index === this.selected ? ' is-selected' : ''}`,
      });
      row.createSpan({
        cls: 'jp-mention-name',
        text: item.kind === 'folder' ? `${item.name}/` : item.name,
      });
      // The parent path disambiguates same-named notes, which a vault of any age
      // is full of. Notes sitting at the vault root have no parent to show.
      const parent = item.path.includes('/')
        ? item.path.slice(0, item.path.lastIndexOf('/'))
        : '';
      if (parent) row.createSpan({ cls: 'jp-mention-path', text: parent });

      // mousedown, not click: click fires after blur has already closed this.
      row.addEventListener('mousedown', event => {
        event.preventDefault();
        this.pick(index);
      });
    });

    // Shown before measuring: a hidden element has no height to position against.
    this.listEl.style.display = '';
    this.position();
    this.scrollSelectedIntoView();
    // Positioned once more after the browser has finished this frame's layout.
    // The composer hides its suggestion buttons on the first keystroke, which
    // makes the centred dialog shorter and slides the textarea down; anything
    // anchored to the textarea before that lands on stale coordinates.
    window.cancelAnimationFrame(this.repositionFrame);
    this.repositionFrame = window.requestAnimationFrame(() => {
      if (this.isOpen) this.position();
    });
  }

  /**
   * Anchors the list to the textarea in viewport coordinates, flipping above it
   * when the space below is too shallow — the normal case, since this composer
   * sits near the bottom of the dialog.
   *
   * Order matters: the height cap is applied first and the box measured after, so
   * the height this positions against is the height that actually renders. Doing
   * it the other way round positions a 240px box and then lets it grow, which
   * makes the list jump on every re-render.
   */
  private position(): void {
    const gap = 4;
    const input = this.inputEl.getBoundingClientRect();
    const below = Math.max(window.innerHeight - input.bottom - gap, 0);
    const above = Math.max(input.top - gap, 0);
    // Below wins unless it is both too short for the list and worse than above.
    this.listEl.style.left = `${input.left}px`;
    this.listEl.style.width = `${input.width}px`;

    // How tall the list wants to be, before either side's room is considered. A
    // short list stays below even in a shallow gap; only a list that genuinely
    // does not fit is worth flipping.
    this.listEl.style.maxHeight = `${MAX_HEIGHT}px`;
    const wanted = this.listEl.offsetHeight;

    const dropDown = below >= wanted || below >= above;
    this.listEl.style.maxHeight = `${Math.min(MAX_HEIGHT, dropDown ? below : above)}px`;

    const height = this.listEl.offsetHeight;
    this.listEl.style.top = dropDown
      ? `${input.bottom + gap}px`
      : `${Math.max(input.top - gap - height, 0)}px`;
  }

  /**
   * Keeps the highlighted row visible without moving the box itself. Written as
   * scroll arithmetic rather than `scrollIntoView`, which is free to scroll every
   * ancestor as well — including the dialog this list is anchored to.
   */
  private scrollSelectedIntoView(): void {
    const row = this.listEl.children[this.selected] as HTMLElement | undefined;
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < this.listEl.scrollTop) {
      this.listEl.scrollTop = top;
    } else if (bottom > this.listEl.scrollTop + this.listEl.clientHeight) {
      this.listEl.scrollTop = bottom - this.listEl.clientHeight;
    }
  }

  private pick(index: number): void {
    const item = this.items[index];
    if (!item || this.startIndex < 0) return;

    const cursor = this.inputEl.selectionStart ?? 0;
    const text = this.inputEl.value;
    // A folder keeps its trailing slash and no space: that is how MyClaudian
    // writes one, and it reads as "everything under here" rather than a file.
    const replacement = item.kind === 'folder' ? `@${item.path}/ ` : `@${item.path} `;
    const next = text.slice(0, this.startIndex) + replacement + text.slice(cursor);
    const caret = this.startIndex + replacement.length;

    this.inputEl.value = next;
    this.inputEl.setSelectionRange(caret, caret);
    // Nothing listens to programmatic value changes, and the composer hides its
    // suggestion buttons on input, so the event is dispatched by hand.
    this.inputEl.dispatchEvent(new Event('input'));

    if (item.kind === 'file') this.callbacks.onPickFile?.(item.path);

    this.close();
    this.inputEl.focus();
  }

  private close(): void {
    this.startIndex = -1;
    this.items = [];
    this.listEl.style.display = 'none';
    this.listEl.empty();
  }
}
