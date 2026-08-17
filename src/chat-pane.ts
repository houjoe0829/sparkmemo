/**
 * Chat pane — the UI behind the sidebar's chat tab.
 *
 * Kept out of capture-view.ts, which is already ~6.5k lines. The pane owns its
 * own DOM and talks to the runtime through a lazily-imported module so that
 * nothing Node-flavoured is pulled in until the user actually sends a message.
 *
 * Two views share the pane, mirroring the drill-in pattern the location and
 * tag tabs already use: a list of saved conversations, and one open thread.
 */

import { Component, MarkdownRenderer, Menu, Notice, Platform, TFile, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { ChatChunk, ChatImage, StreamHandle } from './chat-runtime';
import {
  ChatStore,
  createConversation,
  deriveTitle,
  flattenBlocks,
  type ChatSeed,
  type Conversation,
  type MessageBlock,
} from './chat-store';
import { t } from './i18n';
import { extractImageEmbeds, type SparkMemoSettings } from './section';

export type { ChatSeed } from './chat-store';

/**
 * Base instructions. The memo itself is appended by {@link buildSystemPrompt}
 * so it stays in the system prompt for every turn instead of being re-sent as
 * part of each user message.
 *
 * These are *appended* to Claude Code's own system prompt (the runtime passes
 * `--append-system-prompt`), so they set the register for this pane without
 * displacing the tool-usage instructions that make the tools work. Written as
 * an addendum for that reason: they say what kind of conversation this is, and
 * leave everything else alone.
 */
const BASE_SYSTEM_PROMPT = [
  'For this conversation you are a thinking partner for the user, discussing an entry from their personal journal.',
  'The working directory is the user\'s Obsidian vault: their notes are the material, not a codebase.',
  'Be concrete and concise. Ask a clarifying question when the entry is ambiguous rather than guessing.',
  'Reply in the same language the user writes in.',
].join(' ');

function buildSystemPrompt(seed: ChatSeed): string {
  return [
    BASE_SYSTEM_PROMPT,
    '',
    `The journal entry under discussion was written on ${seed.date} at ${seed.timestamp}:`,
    '',
    '<entry>',
    seed.text,
    '</entry>',
  ].join('\n');
}

/** Models offered in the composer dropdown. */
const MODEL_CHOICES = ['sonnet', 'opus', 'haiku'];

/** Lines of a tool's output kept in the row; the rest is summarised away. */
const TOOL_RESULT_LINES = 20;

/**
 * Permission modes offered in the composer, narrowest first.
 *
 * A subset of what the CLI accepts. The omitted ones (`auto`, `manual`,
 * `dontAsk`) only differ in how they *ask*, and headless mode never asks, so
 * offering them would suggest a confirmation step that does not exist here.
 */
const PERMISSION_MODES = ['plan', 'acceptEdits', 'bypassPermissions'] as const;

/** Toolbar icon telling the current permission mode apart at a glance. */
function permissionIcon(mode: string): string {
  switch (mode) {
    case 'plan':
      return 'eye';
    case 'bypassPermissions':
      return 'shield-off';
    default:
      return 'shield';
  }
}

/** Trailing path segment, without pulling in Node's `path` (see chat-runtime). */
function fileNameOnly(p: string): string {
  return p.split('/').pop() ?? p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Drop the `   12→` gutter Read prefixes every line with. It exists so the
 * model can cite line numbers; in the row it is noise that eats the width the
 * actual content needs.
 */
function stripLineNumber(line: string): string {
  return line.replace(/^\s*\d+→/, '');
}

/** Lucide icon for a tool row, by what the tool does rather than its name. */
function toolIcon(name: string): string {
  switch (name) {
    case 'Read':
      return 'file-text';
    case 'Write':
      return 'file-plus';
    case 'Edit':
    case 'NotebookEdit':
      return 'file-pen';
    case 'Bash':
      return 'terminal';
    case 'Glob':
      return 'folder-search';
    case 'Grep':
      return 'search';
    case 'WebSearch':
      return 'globe';
    case 'WebFetch':
      return 'download';
    case 'TodoWrite':
      return 'list-checks';
    case 'Task':
      return 'bot';
    default:
      return 'wrench';
  }
}

/**
 * The one-line gist of a tool call, shown beside its name.
 *
 * At sidebar width a raw argument dump is unreadable, and a turn can make half
 * a dozen calls; the useful part is almost always a single field.
 */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const str = (key: string): string =>
    typeof input[key] === 'string' ? (input[key] as string) : '';

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return fileNameOnly(str('file_path'));
    case 'Bash':
      return truncate(str('command'), 60);
    case 'Glob':
    case 'Grep':
      return truncate(str('pattern'), 60);
    case 'WebSearch':
      return truncate(str('query'), 60);
    case 'WebFetch':
      return truncate(str('url'), 60);
    case 'Task':
      return truncate(str('description'), 60);
    default: {
      // MCP tools and anything unknown: the first string argument is a better
      // guess than nothing, and is usually the subject of the call.
      const first = Object.values(input).find(v => typeof v === 'string');
      return typeof first === 'string' ? truncate(first, 60) : '';
    }
  }
}

/**
 * Display form of a model name. Only the short aliases get capitalised —
 * a full name like `claude-sonnet-5` reads worse as `Claude-sonnet-5`, so it
 * is left alone. The stored value stays lowercase either way; this is purely
 * a label, and the CLI is always handed the original.
 */
function modelLabel(model: string): string {
  if (!/^[a-z]+$/.test(model)) return model;
  return model.charAt(0).toUpperCase() + model.slice(1);
}

/** Scroll offsets at which the context card collapses and expands again. */
const COLLAPSE_COLLAPSE_AT = 12;
const COLLAPSE_EXPAND_AT = 4;

/** Image types the API accepts. Anything else is skipped rather than sent. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Total bytes of inline image data allowed on one message. Well under the
 * API's own ceiling, and high enough for the handful of photos a memo
 * realistically carries.
 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function mimeForPath(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? null;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Chunked so a large image can't blow the argument limit of String.fromCharCode.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export class ChatPane {
  private readonly app: App;
  private readonly getSettings: () => SparkMemoSettings;
  private readonly root: HTMLElement;
  /** Lifecycle owner for MarkdownRenderer.render calls made by this pane. */
  private readonly scope: Component;
  private readonly store: ChatStore;

  // ── DOM ──
  private barEl!: HTMLElement;
  private backBtn!: HTMLButtonElement;
  private titleEl!: HTMLElement;
  private listEl!: HTMLElement;
  private threadEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private contextCardEl!: HTMLElement;
  private contextImagesEl!: HTMLElement;
  private msgListEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private composerEl!: HTMLElement;
  private attachStripEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private modelBtn!: HTMLButtonElement;
  private permissionBtn!: HTMLButtonElement;
  private attachBtn!: HTMLButtonElement;
  private usageEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private fileInputEl!: HTMLInputElement;

  // ── Conversation state ──
  private conversations: Conversation[] = [];
  private loaded = false;
  private active: Conversation | null = null;
  private streaming = false;
  private handle: StreamHandle | null = null;
  /**
   * The memo's own attachments. Shown inside the context card, since they are
   * part of the entry rather than something the user is adding. Sent with the
   * first turn only — after that they live in the CLI's session history.
   */
  private seedImages: Array<ChatImage & { name: string }> = [];
  /** Images the user attached by hand for the next message. Cleared once sent. */
  private pendingImages: Array<ChatImage & { name: string }> = [];

  // ── Streaming render state ──
  /**
   * The in-flight reply is an ordered list of blocks rather than one growing
   * string, because its two sources interleave: text arrives token by token
   * from `stream_event`, while tool calls arrive whole on the assembled
   * `assistant` events. A single string cannot record which came first.
   */
  /** Container element for the in-flight assistant reply. */
  private liveEl: HTMLElement | null = null;
  /** Blocks of the in-flight reply, in arrival order. */
  private liveBlocks: MessageBlock[] = [];
  /** One element per block, index-aligned with `liveBlocks`. */
  private liveEls: HTMLElement[] = [];
  /**
   * Index of the trailing text block still receiving deltas, or -1 when the
   * tail is not text. Only this block is re-parsed per frame.
   */
  private dirtyTextIndex = -1;
  /** tool_use id to its index in `liveBlocks`, for matching results back. */
  private toolIndex = new Map<string, number>();
  /** Pending rAF id, so many deltas collapse into one re-render per frame. */
  private renderFrame: number | null = null;
  /** Height of the context card while expanded, used by the collapse guard. */
  private expandedContextHeight = 0;

  constructor(app: App, root: HTMLElement, scope: Component, getSettings: () => SparkMemoSettings) {
    this.app = app;
    this.root = root;
    this.scope = scope;
    this.getSettings = getSettings;
    this.store = new ChatStore(app.vault.adapter);
    this.build();
  }

  // ── Construction ────────────────────────────────────────────────────────

  private build(): void {
    this.root.addClass('jp-chat-pane');

    // Top bar: back arrow (thread view only) + title.
    this.barEl = this.root.createDiv({ cls: 'jp-chat-bar' });
    this.backBtn = this.barEl.createEl('button', {
      cls: 'jp-chat-back-btn',
      attr: { 'aria-label': t('chat.backToList'), title: t('chat.backToList') },
    });
    setIcon(this.backBtn, 'arrow-left');
    this.backBtn.addEventListener('click', () => this.showList());
    this.titleEl = this.barEl.createDiv({ cls: 'jp-chat-bar-title' });
    this.barEl.hide();

    // List view.
    this.listEl = this.root.createDiv({ cls: 'jp-chat-list' });

    // Thread view.
    this.threadEl = this.root.createDiv({ cls: 'jp-chat-thread' });
    this.threadEl.hide();

    // The context card lives inside the scroll area so it scrolls away with
    // the conversation, and sticks to the top in a collapsed form once it
    // would otherwise be gone. Messages get their own inner container so
    // re-rendering them never wipes the card.
    this.messagesEl = this.threadEl.createDiv({ cls: 'jp-chat-messages' });
    this.contextEl = this.messagesEl.createDiv({ cls: 'jp-chat-context' });
    this.msgListEl = this.messagesEl.createDiv({ cls: 'jp-chat-msg-list' });

    this.messagesEl.addEventListener('scroll', () => this.syncContextCollapse());

    this.buildComposer();
  }

  /**
   * The composer is one rounded card: attachment strip, textarea, then a
   * toolbar row holding the model picker, the attach button, the context
   * readout, and the send button.
   */
  private buildComposer(): void {
    this.composerEl = this.threadEl.createDiv({ cls: 'jp-chat-composer' });

    this.attachStripEl = this.composerEl.createDiv({ cls: 'jp-chat-attach-strip' });
    this.attachStripEl.hide();

    this.inputEl = this.composerEl.createEl('textarea', {
      cls: 'jp-chat-input',
      attr: { placeholder: t('chat.inputPlaceholder'), rows: '1' },
    });

    const toolbar = this.composerEl.createDiv({ cls: 'jp-chat-toolbar' });

    this.modelBtn = toolbar.createEl('button', {
      cls: 'jp-chat-tool-btn jp-chat-model-btn',
      attr: { 'aria-label': t('chat.model'), title: t('chat.model') },
    });
    this.modelBtn.addEventListener('click', evt => this.openModelMenu(evt));

    this.permissionBtn = toolbar.createEl('button', {
      cls: 'jp-chat-tool-btn jp-chat-permission-btn',
    });
    this.permissionBtn.addEventListener('click', evt => this.openPermissionMenu(evt));

    this.attachBtn = toolbar.createEl('button', {
      cls: 'jp-chat-tool-btn',
      attr: { 'aria-label': t('chat.attachImage'), title: t('chat.attachImage') },
    });
    setIcon(this.attachBtn, 'image-plus');
    this.attachBtn.addEventListener('click', () => this.fileInputEl.click());

    // Hidden picker driving the attach button.
    this.fileInputEl = this.composerEl.createEl('input', {
      cls: 'jp-chat-file-input',
      attr: { type: 'file', accept: 'image/*', multiple: 'true' },
    });
    this.fileInputEl.hide();
    this.fileInputEl.addEventListener('change', () => {
      void this.addFilesFromPicker();
    });

    // Explicit spacer rather than margin-left:auto on the usage readout —
    // the readout is hidden until a turn completes, and a hidden element
    // can't push anything.
    toolbar.createDiv({ cls: 'jp-chat-toolbar-spacer' });

    this.usageEl = toolbar.createDiv({ cls: 'jp-chat-usage' });

    this.sendBtn = toolbar.createEl('button', { cls: 'jp-chat-send' });
    setIcon(this.sendBtn, 'arrow-up');
    this.sendBtn.addEventListener('click', () => {
      if (this.streaming) this.stop();
      else void this.send();
    });

    this.inputEl.addEventListener('keydown', evt => {
      // isComposing guards IME input: without it, hitting Enter to pick a
      // Chinese candidate would fire the message half-typed.
      if (evt.key === 'Enter' && !evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        if (!this.streaming) void this.send();
      }
    });

    this.inputEl.addEventListener('input', () => this.autoGrow());

    // Pasting a screenshot straight into the box is the fastest path, so it
    // gets the same treatment as the attach button.
    this.inputEl.addEventListener('paste', evt => {
      const files = Array.from(evt.clipboardData?.files ?? []);
      const images = files.filter(f => f.type.startsWith('image/'));
      if (images.length === 0) return;
      evt.preventDefault();
      void this.addFiles(images);
    });

    // Focus ring follows the textarea but is drawn on the whole card.
    this.inputEl.addEventListener('focus', () => this.composerEl.addClass('is-focused'));
    this.inputEl.addEventListener('blur', () => this.composerEl.removeClass('is-focused'));
  }

  /** Grow the textarea with its content, up to a cap. */
  private autoGrow(): void {
    this.inputEl.setCssStyles({ height: 'auto' });
    this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 160)}px`;
  }

  // ── Composer controls ───────────────────────────────────────────────────

  /** Model in force for the open thread: its own choice, else the setting. */
  private currentModel(): string {
    return this.active?.model || this.getSettings().chatModel || 'sonnet';
  }

  private currentPermissionMode(): string {
    return this.active?.permissionMode || this.getSettings().chatPermissionMode || 'acceptEdits';
  }

  /**
   * Pick how much this thread is allowed to do.
   *
   * Lives on the toolbar rather than only in settings because it is the one
   * control that decides whether a reply can rewrite a note: headless mode
   * never asks before running a tool, so the choice has to be made in advance,
   * and it has to be visible while making it.
   */
  private openPermissionMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const current = this.currentPermissionMode();

    for (const mode of PERMISSION_MODES) {
      menu.addItem(item =>
        item
          .setTitle(t(`chat.permission.${mode}` as Parameters<typeof t>[0]))
          .setChecked(mode === current)
          .onClick(() => {
            const conversation = this.active;
            if (!conversation) return;
            conversation.permissionMode = mode;
            this.refreshComposerState();
            if (conversation.messages.length > 0) void this.persist(conversation);
          }),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private openModelMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const current = this.currentModel();
    // The setting's model may be something custom; make sure it is offered.
    const choices = MODEL_CHOICES.includes(current) ? MODEL_CHOICES : [current, ...MODEL_CHOICES];

    for (const model of choices) {
      menu.addItem(item =>
        item
          .setTitle(modelLabel(model))
          .setChecked(model === current)
          .onClick(() => {
            const conversation = this.active;
            if (!conversation) return;
            conversation.model = model;
            this.refreshComposerState();
            // Only write through for a thread that already exists on disk;
            // an unsent one is still provisional.
            if (conversation.messages.length > 0) void this.persist(conversation);
          }),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /** Repaint model label, context readout and send button from current state. */
  private refreshComposerState(): void {
    this.modelBtn.setText(modelLabel(this.currentModel()));

    const mode = this.currentPermissionMode();
    setIcon(this.permissionBtn, permissionIcon(mode));
    const modeLabel = t(`chat.permission.${mode}` as Parameters<typeof t>[0]);
    this.permissionBtn.setAttr('aria-label', modeLabel);
    this.permissionBtn.setAttr('title', modeLabel);
    this.permissionBtn.toggleClass('is-unguarded', mode === 'bypassPermissions');

    const used = this.active?.contextTokens ?? 0;
    const window = this.active?.contextWindow ?? 0;
    if (used > 0 && window > 0) {
      const percent = Math.min(100, Math.max(0, Math.round((used / window) * 100)));
      this.usageEl.setText(t('chat.usage', { percent: String(percent) }));
      this.usageEl.setAttr('title', t('chat.usageDetail', {
        used: used.toLocaleString(),
        total: window.toLocaleString(),
      }));
      this.usageEl.show();
    } else {
      this.usageEl.hide();
    }

    this.setSendButtonState();
  }

  // ── Attachments ─────────────────────────────────────────────────────────

  /** Read a vault image into an inline attachment, or null if unusable. */
  private async readVaultImage(path: string): Promise<(ChatImage & { name: string }) | null> {
    const mediaType = mimeForPath(path);
    if (!mediaType) return null;

    const file = this.app.metadataCache.getFirstLinkpathDest(path, '');
    if (!(file instanceof TFile)) return null;

    try {
      const buffer = await this.app.vault.readBinary(file);
      return { mediaType, data: toBase64(buffer), name: file.name };
    } catch {
      return null;
    }
  }

  /**
   * Collect the images a memo embeds, so the model can actually see what the
   * entry is talking about instead of only its caption.
   */
  private async loadSeedImages(seed: ChatSeed): Promise<void> {
    // extractImageEmbeds only sees Obsidian's ![[wiki]] form, which is what
    // the capture box writes; standard ![](path) markdown can still appear in
    // hand-edited memos, so pick that up too.
    const markdown = Array.from(seed.text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g))
      .map(m => decodeURIComponent(m[1].trim()))
      .filter(path => !/^[a-z]+:\/\//i.test(path));
    const paths = [...new Set([...extractImageEmbeds(seed.text), ...markdown])];
    if (paths.length === 0) return;

    const loaded: Array<ChatImage & { name: string }> = [];
    for (const path of paths) {
      const image = await this.readVaultImage(path);
      if (image) loaded.push(image);
    }
    if (loaded.length === 0) return;

    // The thread may have been closed or swapped while these were read.
    if (this.active?.seed !== seed) return;
    this.seedImages = loaded;
    this.renderSeedImages();
  }

  /** Paint the memo's own attachments into the context card. */
  private renderSeedImages(): void {
    this.contextImagesEl.empty();
    if (this.seedImages.length === 0) {
      this.contextImagesEl.hide();
      return;
    }
    this.contextImagesEl.show();

    for (const image of this.seedImages) {
      const thumb = this.contextImagesEl.createEl('img', { cls: 'jp-chat-context-thumb' });
      thumb.src = `data:${image.mediaType};base64,${image.data}`;
      thumb.alt = image.name;
      thumb.title = image.name;
    }
  }

  private async addFilesFromPicker(): Promise<void> {
    const files = Array.from(this.fileInputEl.files ?? []);
    // Reset so picking the same file twice in a row still fires 'change'.
    this.fileInputEl.value = '';
    await this.addFiles(files);
  }

  private async addFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const buffer = await file.arrayBuffer();
        this.pendingImages.push({
          mediaType: file.type,
          data: toBase64(buffer),
          name: file.name || t('chat.pastedImage'),
        });
      } catch {
        // Unreadable file — skip it rather than failing the whole paste.
      }
    }
    this.trimPendingImages();
    this.renderAttachStrip();
  }

  /** Drop attachments past the size ceiling, oldest kept, and warn once. */
  private trimPendingImages(): void {
    let total = 0;
    const kept: Array<ChatImage & { name: string }> = [];
    for (const image of this.pendingImages) {
      // base64 inflates by ~4/3; compare on decoded size.
      const bytes = Math.floor((image.data.length * 3) / 4);
      if (total + bytes > MAX_IMAGE_BYTES) continue;
      total += bytes;
      kept.push(image);
    }
    if (kept.length !== this.pendingImages.length) {
      new Notice(t('chat.imagesTooLarge'));
      this.pendingImages = kept;
    }
  }

  private renderAttachStrip(): void {
    this.attachStripEl.empty();
    if (this.pendingImages.length === 0) {
      this.attachStripEl.hide();
      return;
    }
    this.attachStripEl.show();

    this.pendingImages.forEach((image, index) => {
      const chip = this.attachStripEl.createDiv({ cls: 'jp-chat-attach-chip' });
      const thumb = chip.createEl('img', { cls: 'jp-chat-attach-thumb' });
      thumb.src = `data:${image.mediaType};base64,${image.data}`;
      thumb.alt = image.name;

      const remove = chip.createEl('button', {
        cls: 'jp-chat-attach-remove',
        attr: { 'aria-label': t('chat.removeImage'), title: t('chat.removeImage') },
      });
      setIcon(remove, 'x');
      remove.addEventListener('click', () => {
        this.pendingImages.splice(index, 1);
        this.renderAttachStrip();
      });
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Called whenever the chat tab becomes visible. Loads saved conversations
   * on first use, then shows whichever view was last open.
   */
  async activate(): Promise<void> {
    await this.ensureLoaded();
    if (this.active) this.inputEl.focus();
    else this.renderList();
  }

  /** Open a brand-new conversation seeded with `seed` and show it. */
  async startFromMemo(seed: ChatSeed): Promise<void> {
    await this.ensureLoaded();
    this.stop();

    // Held in memory only. A thread that never gets a message written to it is
    // not worth a file or a row — committing on first send keeps the list free
    // of empty "0 messages" entries from someone who opened chat and backed out.
    const conversation = createConversation(
      crypto.randomUUID(),
      seed,
      Date.now(),
      this.getSettings().chatModel || 'sonnet',
      this.getSettings().chatPermissionMode || 'acceptEdits',
    );
    this.openConversation(conversation);
  }

  /** Focus the composer, e.g. after switching back to the chat tab. */
  focusInput(): void {
    if (this.active) this.inputEl.focus();
  }

  /** Kill any in-flight turn. Safe to call when idle. */
  stop(): void {
    if (this.handle) {
      this.handle.abort();
      this.handle = null;
    }
    this.streaming = false;
    this.setSendButtonState();
  }

  /** Release resources when the view closes. */
  dispose(): void {
    this.stop();
    if (this.renderFrame !== null) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
  }

  // ── View switching ──────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.conversations = await this.store.loadAll();
    } catch {
      this.conversations = [];
    }
  }

  private showList(): void {
    this.stop();
    this.active = null;
    this.threadEl.hide();
    this.listEl.show();
    // No bar in list view: the active tab icon already says where you are, so
    // a "Chat" header would just eat a row.
    this.barEl.hide();
    this.renderList();
  }

  private openConversation(conversation: Conversation): void {
    this.stop();
    this.active = conversation;
    this.listEl.hide();
    this.threadEl.show();
    this.barEl.show();
    this.titleEl.setText(conversation.title || t('chat.untitled'));

    this.renderContextCard(conversation.seed);
    this.renderMessages(conversation);

    // Attachments belong to the thread being opened, not the previous one.
    this.pendingImages = [];
    this.renderAttachStrip();
    this.seedImages = [];
    this.renderSeedImages();
    void this.loadSeedImages(conversation.seed);

    this.inputEl.value = '';
    this.autoGrow();
    this.refreshComposerState();
    window.setTimeout(() => this.inputEl.focus(), 50);
  }

  // ── List rendering ──────────────────────────────────────────────────────

  private renderList(): void {
    this.listEl.empty();

    if (this.conversations.length === 0) {
      this.listEl.createDiv({ cls: 'jp-chat-empty', text: t('chat.emptyHint') });
      return;
    }

    for (const conversation of this.conversations) {
      const row = this.listEl.createDiv({ cls: 'jp-chat-list-item' });

      const main = row.createDiv({ cls: 'jp-chat-list-main' });
      main.createDiv({
        cls: 'jp-chat-list-title',
        text: conversation.title || t('chat.untitled'),
      });

      const meta = main.createDiv({ cls: 'jp-chat-list-meta' });
      const turns = conversation.messages.filter(m => m.role === 'user').length;
      const countLabel =
        turns === 1 ? t('chat.turnCountOne') : t('chat.turnCount', { count: String(turns) });
      meta.setText(`${this.formatDate(conversation.updatedAt)} · ${countLabel}`);
      meta.setAttr('title', conversation.seed.text);

      const del = row.createEl('button', {
        cls: 'jp-chat-list-delete',
        attr: { 'aria-label': t('chat.delete'), title: t('chat.delete') },
      });
      setIcon(del, 'trash-2');
      del.addEventListener('click', evt => {
        // Without this the row's own click handler would open the very
        // conversation being deleted.
        evt.stopPropagation();
        void this.deleteConversation(conversation);
      });

      row.addEventListener('click', () => this.openConversation(conversation));
      row.addEventListener('contextmenu', evt => {
        evt.preventDefault();
        const menu = new Menu();
        menu.addItem(item =>
          item
            .setTitle(t('chat.delete'))
            .setIcon('trash-2')
            .onClick(() => {
              void this.deleteConversation(conversation);
            }),
        );
        menu.showAtMouseEvent(evt);
      });
    }
  }

  /**
   * Compact relative-ish stamp for the list: time for today, month/day for
   * this year, and the year only once it actually disambiguates something.
   */
  private formatDate(epochMs: number): string {
    const d = new Date(epochMs);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return time;

    const monthDay = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (d.getFullYear() === now.getFullYear()) return `${monthDay} ${time}`;
    return `${d.getFullYear()}-${monthDay}`;
  }

  private async deleteConversation(conversation: Conversation): Promise<void> {
    // Drop it from the list first, so the re-render inside showList() (and the
    // one below, when deleting from the list view) never paints it again.
    this.conversations = this.conversations.filter(c => c.id !== conversation.id);
    if (this.active?.id === conversation.id) this.showList();
    else this.renderList();
    try {
      await this.store.delete(conversation.id);
    } catch (err) {
      new Notice(t('chat.deleteFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  // ── Thread rendering ────────────────────────────────────────────────────

  private renderContextCard(seed: ChatSeed): void {
    this.contextEl.empty();
    this.contextCardEl = this.contextEl.createDiv({ cls: 'jp-chat-context-card' });

    const meta = this.contextCardEl.createDiv({ cls: 'jp-chat-context-meta' });
    const icon = meta.createSpan({ cls: 'jp-chat-context-icon' });
    setIcon(icon, 'quote');
    meta.createSpan({
      cls: 'jp-chat-context-date',
      text: `${seed.date} ${seed.timestamp}`.trim(),
    });

    const body = this.contextCardEl.createDiv({ cls: 'jp-chat-context-body' });
    // Plain text, not markdown: the card is a reference, and rendering the
    // embeds inline would pull full-size images and audio players into what
    // should stay a compact summary. Attachments get thumbnails instead.
    body.setText(seed.text);

    this.contextImagesEl = this.contextCardEl.createDiv({ cls: 'jp-chat-context-images' });
    this.contextImagesEl.hide();

    // A freshly rendered card starts expanded; the scroll position decides.
    this.syncContextCollapse();
  }

  /**
   * Collapse the context card once the thread has scrolled past it, so a long
   * memo stops eating the height the conversation needs. Scrolling back to the
   * top restores it.
   *
   * The guard below is what keeps this from flickering. Collapsing shortens
   * the scrollable content, so on a thread that is only just long enough to
   * scroll, collapsing removes the scroll entirely — the browser clamps
   * scrollTop back to 0, which expands the card, which makes it scrollable
   * again. Requiring enough slack that the thread stays scrollable after
   * collapsing breaks that loop.
   */
  private syncContextCollapse(): void {
    const collapsed = this.contextEl.hasClass('is-collapsed');
    // Only measurable while expanded, so cache it whenever we can.
    if (!collapsed) this.expandedContextHeight = this.contextEl.offsetHeight;

    const scrollTop = this.messagesEl.scrollTop;

    if (collapsed) {
      // Expand a touch earlier than we collapse: the asymmetry stops a
      // rubber-band overscroll or a one-pixel rounding wobble from toggling
      // the card back and forth.
      if (scrollTop <= COLLAPSE_EXPAND_AT) this.contextEl.removeClass('is-collapsed');
      return;
    }

    if (scrollTop <= COLLAPSE_COLLAPSE_AT) return;

    const overflow = this.messagesEl.scrollHeight - this.messagesEl.clientHeight;
    // Collapsing can shorten the content by at most the card's expanded
    // height, so this bound guarantees the thread is still scrollable after.
    if (overflow > this.expandedContextHeight + COLLAPSE_COLLAPSE_AT) {
      this.contextEl.addClass('is-collapsed');
    }
  }

  private renderMessages(conversation: Conversation): void {
    this.msgListEl.empty();
    this.resetLiveState();

    if (conversation.messages.length === 0) {
      this.msgListEl.createDiv({ cls: 'jp-chat-empty', text: t('chat.threadEmptyHint') });
      return;
    }

    for (const message of conversation.messages) {
      const contentEl = this.addMessage(message.role, message.blocks ? '' : message.content);
      // Replay through the same block renderer the live path uses, so a
      // reopened thread is identical to the one that was just streamed.
      if (message.blocks) this.renderBlocks(contentEl, message.blocks);
    }
  }

  /** Paint a settled list of blocks into `container`. */
  private renderBlocks(container: HTMLElement, blocks: MessageBlock[]): void {
    for (const block of blocks) {
      if (block.kind === 'text') {
        void this.renderMarkdown(container.createDiv({ cls: 'jp-chat-msg-block' }), block.text);
      } else {
        this.renderToolBlock(container, block);
      }
    }
  }

  private resetLiveState(): void {
    this.liveEl = null;
    this.liveBlocks = [];
    this.liveEls = [];
    this.dirtyTextIndex = -1;
    this.toolIndex.clear();
  }

  private addMessage(role: 'user' | 'assistant', content: string): HTMLElement {
    // Drop the placeholder the moment real content arrives.
    this.msgListEl.find('.jp-chat-empty')?.remove();

    const el = this.msgListEl.createDiv({ cls: `jp-chat-msg jp-chat-msg-${role}` });
    const contentEl = el.createDiv({ cls: 'jp-chat-msg-content' });
    if (content.length > 0) void this.renderMarkdown(contentEl, content);
    this.scrollToBottom();
    return contentEl;
  }

  private async renderMarkdown(el: HTMLElement, markdown: string): Promise<void> {
    el.empty();
    try {
      await MarkdownRenderer.render(this.app, markdown, el, '', this.scope);
      // Wrap tables so a wide one scrolls inside itself. Without this its
      // overflow-x propagates and turns the whole message list into a
      // horizontal scroller.
      el.findAll('table').forEach(table => {
        if (table.parentElement?.hasClass('jp-chat-table-wrap')) return;
        const wrap = createDiv({ cls: 'jp-chat-table-wrap' });
        table.replaceWith(wrap);
        wrap.appendChild(table);
      });
    } catch {
      el.createDiv({ cls: 'jp-chat-render-error', text: t('chat.renderFailed') });
    }
  }

  /**
   * Queue a re-render of the block currently receiving deltas. Deltas arrive
   * per token; without this coalescing each one would trigger a markdown parse
   * and the pane would lock up on a long answer.
   *
   * Only the trailing text block is re-parsed. Once a tool call lands the
   * block before it is final and never touched again, so the per-frame cost is
   * bounded by the paragraph being typed rather than by everything said so far
   * — which matters more here than it used to, since a tool-using turn runs far
   * longer than a plain one.
   */
  private scheduleLiveRender(): void {
    if (this.renderFrame !== null) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.renderDirtyBlock();
    });
  }

  private renderDirtyBlock(): void {
    const i = this.dirtyTextIndex;
    if (i < 0) return;
    const block = this.liveBlocks[i];
    const el = this.liveEls[i];
    if (!el || block?.kind !== 'text') return;
    void this.renderMarkdown(el, block.text).then(() => this.scrollToBottom());
  }

  /**
   * Append a block to the in-flight reply and create its element, keeping
   * `liveBlocks` and `liveEls` index-aligned.
   */
  private appendLiveBlock(block: MessageBlock): number {
    const container = this.liveEl;
    if (!container) return -1;
    const index = this.liveBlocks.length;
    this.liveBlocks.push(block);
    if (block.kind === 'text') {
      this.liveEls.push(container.createDiv({ cls: 'jp-chat-msg-block' }));
      this.dirtyTextIndex = index;
    } else {
      this.liveEls.push(this.renderToolBlock(container, block));
      // The text before a tool call is settled; stop re-parsing it.
      this.dirtyTextIndex = -1;
      this.toolIndex.set(block.id, index);
    }
    return index;
  }

  /**
   * One tool call. Rendered with `setText` throughout, never through
   * MarkdownRenderer: tool output is whatever a file or a command produced, and
   * parsing it as markdown would let that content inject headings and links
   * into the conversation.
   */
  private renderToolBlock(
    container: HTMLElement,
    block: Extract<MessageBlock, { kind: 'tool' }>,
  ): HTMLElement {
    const el = container.createDiv({ cls: 'jp-chat-tool' });
    if (block.name === 'Bash') el.addClass('jp-chat-tool-bash');

    // The whole header is the toggle, so the hit target matches what the eye
    // reads as one row.
    const header = el.createDiv({
      cls: 'jp-chat-tool-header',
      attr: { role: 'button', tabindex: '0', 'aria-expanded': 'false' },
    });
    setIcon(header.createSpan({ cls: 'jp-chat-tool-chevron' }), 'chevron-right');
    setIcon(header.createSpan({ cls: 'jp-chat-tool-icon' }), toolIcon(block.name));
    header.createSpan({ cls: 'jp-chat-tool-name', text: block.name });
    header.createSpan({ cls: 'jp-chat-tool-summary', text: toolSummary(block.name, block.input) });
    header.createSpan({ cls: 'jp-chat-tool-status' });

    const toggle = () => {
      const open = el.hasClass('is-expanded');
      el.toggleClass('is-expanded', !open);
      header.setAttr('aria-expanded', String(!open));
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', evt => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      evt.preventDefault();
      toggle();
    });

    el.createDiv({ cls: 'jp-chat-tool-content' });
    this.updateToolBlock(el, block);
    return el;
  }

  /** Repaint a tool row's status and result body in place. */
  private updateToolBlock(
    el: HTMLElement,
    block: Extract<MessageBlock, { kind: 'tool' }>,
  ): void {
    const status = el.find('.jp-chat-tool-status');
    const content = el.find('.jp-chat-tool-content');
    if (!status || !content) return;

    const running = block.result === undefined;
    el.toggleClass('is-error', block.isError === true);
    el.toggleClass('is-running', running);

    status.empty();
    setIcon(status, running ? 'loader-2' : block.isError === true ? 'x' : 'check');

    content.empty();

    // Echo the command itself: for Bash the argument *is* the interesting
    // part, and the header truncates it.
    if (block.name === 'Bash' && typeof block.input.command === 'string') {
      content
        .createDiv({ cls: 'jp-chat-tool-command' })
        .setText(`$ ${block.input.command}`);
    }

    if (running) return;
    const lines = (block.result ?? '').split('\n').map(stripLineNumber);
    for (const line of lines.slice(0, TOOL_RESULT_LINES)) {
      content.createDiv({ cls: 'jp-chat-tool-line' }).setText(line);
    }
    if (lines.length > TOOL_RESULT_LINES) {
      content.createDiv({
        cls: 'jp-chat-tool-more',
        text: t('chat.toolMoreLines', { count: String(lines.length - TOOL_RESULT_LINES) }),
      });
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    // Content just grew or shrank, which can flip whether collapsing is safe.
    this.syncContextCollapse();
  }

  private setSendButtonState(): void {
    this.sendBtn.toggleClass('is-streaming', this.streaming);
    setIcon(this.sendBtn, this.streaming ? 'square' : 'arrow-up');
    this.sendBtn.setAttr('aria-label', this.streaming ? t('chat.stop') : t('chat.send'));
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  private async send(): Promise<void> {
    const conversation = this.active;
    if (this.streaming || !conversation) return;

    const text = this.inputEl.value.trim();
    if (text.length === 0) return;

    if (!Platform.isDesktopApp) {
      new Notice(t('chat.desktopOnly'));
      return;
    }

    const vaultPath = this.getVaultPath();
    if (!vaultPath) {
      new Notice(t('chat.noVaultPath'));
      return;
    }

    const runtime = await import('./chat-runtime');
    const settings = this.getSettings();
    const cliPath = runtime.resolveClaudePath(settings.chatCliPath);
    if (!cliPath) {
      new Notice(t('chat.cliNotFound'));
      return;
    }

    this.inputEl.value = '';
    this.autoGrow();

    // The memo's own attachments ride along with the opening turn only; from
    // then on the CLI session already holds them.
    const isFirstTurn = conversation.messages.length === 0;
    const attached = [...(isFirstTurn ? this.seedImages : []), ...this.pendingImages];
    const images = attached.map(({ mediaType, data }) => ({ mediaType, data }));

    // Clear the user's strip immediately, so a slow reply can't leave those
    // thumbnails looking like they are still waiting to be sent.
    const manualCount = this.pendingImages.length;
    this.pendingImages = [];
    this.renderAttachStrip();

    // First user message names the conversation.
    if (conversation.messages.length === 0) {
      conversation.title = deriveTitle(text) || conversation.title;
      this.titleEl.setText(conversation.title || t('chat.untitled'));
    }
    // Only note the images the user attached themselves — the memo's own are
    // already visible in the context card above.
    const shown =
      manualCount > 0
        ? `${text}\n\n*${t('chat.imageCount', { count: String(manualCount) })}*`
        : text;
    conversation.messages.push({ role: 'user', content: shown, timestamp: Date.now() });
    this.addMessage('user', shown);
    void this.persist(conversation);

    this.streaming = true;
    this.setSendButtonState();

    this.resetLiveState();
    this.liveEl = this.addMessage('assistant', '');
    this.liveEl.parentElement?.addClass('jp-chat-msg-pending');

    const handle = runtime.streamClaude({
      prompt: text,
      images,
      cwd: vaultPath,
      cliPath,
      model: this.currentModel(),
      permissionMode: this.currentPermissionMode(),
      loadUserSettings: this.getSettings().chatLoadUserSettings,
      systemPrompt: buildSystemPrompt(conversation.seed),
      resumeSessionId: conversation.cliSessionId ?? undefined,
      newSessionId: conversation.cliSessionId ? undefined : crypto.randomUUID(),
    });
    this.handle = handle;

    try {
      for await (const chunk of handle.chunks) {
        // A newer turn, another conversation, or a delete replaced this one —
        // stop painting so a stale stream can't write into the current view.
        if (this.handle !== handle || this.active !== conversation) break;
        this.consume(chunk, conversation);
      }
    } catch (err) {
      this.finishTurn(conversation, err instanceof Error ? err.message : String(err));
      return;
    }

    if (this.handle === handle) this.finishTurn(conversation, null);
  }

  private consume(chunk: ChatChunk, conversation: Conversation): void {
    switch (chunk.type) {
      case 'session':
        // First turn only; later turns resume this id.
        if (!conversation.cliSessionId) conversation.cliSessionId = chunk.id;
        break;
      case 'text': {
        // Extend the trailing text block, or start one if a tool call ended
        // the last stretch of prose.
        const tail = this.liveBlocks[this.liveBlocks.length - 1];
        if (tail?.kind === 'text') {
          tail.text += chunk.content;
          this.dirtyTextIndex = this.liveBlocks.length - 1;
        } else {
          this.appendLiveBlock({ kind: 'text', text: chunk.content });
        }
        this.scheduleLiveRender();
        break;
      }
      case 'tool_use':
        this.appendLiveBlock({
          kind: 'tool',
          id: chunk.id,
          name: chunk.name,
          input: chunk.input,
        });
        this.scrollToBottom();
        break;
      case 'tool_result': {
        const index = this.toolIndex.get(chunk.id);
        if (index === undefined) break;
        const block = this.liveBlocks[index];
        const el = this.liveEls[index];
        if (block?.kind !== 'tool' || !el) break;
        block.result = chunk.content;
        block.isError = chunk.isError;
        this.updateToolBlock(el, block);
        this.scrollToBottom();
        break;
      }
      case 'usage':
        conversation.contextTokens = chunk.contextTokens;
        conversation.contextWindow = chunk.contextWindow;
        this.refreshComposerState();
        break;
      case 'error':
        this.finishTurn(conversation, chunk.content);
        break;
      case 'done':
        break;
    }
  }

  /** Settle the in-flight reply, optionally appending an error line. */
  private finishTurn(conversation: Conversation, error: string | null): void {
    if (this.renderFrame !== null) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }

    const el = this.liveEl;
    const blocks = this.liveBlocks;

    // A tool still without a result means the turn was stopped mid-call; mark
    // it so the row settles instead of spinning forever.
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.kind !== 'tool' || block.result !== undefined) continue;
      block.result = t('chat.toolInterrupted');
      block.isError = true;
      const toolEl = this.liveEls[i];
      if (toolEl) this.updateToolBlock(toolEl, block);
    }

    if (el) {
      el.parentElement?.removeClass('jp-chat-msg-pending');
      // Final render happens outside the rAF path so the last deltas, which
      // may have arrived after the most recent frame, are never dropped.
      this.renderDirtyBlock();
      if (error !== null) {
        el.createDiv({ cls: 'jp-chat-error', text: t('chat.error', { error }) });
      }
      this.scrollToBottom();
    }

    // A turn can be pure tool calls with no prose, so the guard is on blocks
    // rather than on text — keying it to text would discard such a turn whole.
    if (blocks.length > 0) {
      conversation.messages.push({
        role: 'assistant',
        content: flattenBlocks(blocks),
        blocks,
        timestamp: Date.now(),
      });
    }
    void this.persist(conversation);

    this.liveEl = null;
    this.liveBlocks = [];
    this.liveEls = [];
    this.dirtyTextIndex = -1;
    this.toolIndex.clear();
    this.streaming = false;
    this.handle = null;
    this.setSendButtonState();
  }

  /** Write the conversation to disk and re-sort the list by recency. */
  private async persist(conversation: Conversation): Promise<void> {
    // First save is also when the thread joins the list.
    if (!this.conversations.some(c => c.id === conversation.id)) {
      this.conversations.unshift(conversation);
    }
    try {
      await this.store.save(conversation, Date.now());
      this.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      new Notice(t('chat.saveFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Absolute path of the vault on disk, or null on a non-file vault. */
  private getVaultPath(): string | null {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    return typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : null;
  }
}
