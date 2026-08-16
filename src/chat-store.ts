/**
 * Chat persistence — one JSON file per conversation under a hidden folder in
 * the vault.
 *
 * Storing inside the vault (rather than the plugin's data.json) means
 * conversations ride along with whatever syncs the vault, and a single runaway
 * thread can't bloat the settings file that every other feature reads.
 *
 * Deliberately Obsidian-free, like stats.ts and map-view.ts: the caller passes
 * in a {@link ChatStorageAdapter}, which Obsidian's own `vault.adapter`
 * already satisfies structurally.
 */

/** The memo a conversation was opened from. */
export interface ChatSeed {
  /** `HH:MM` as written in the daily note. */
  timestamp: string;
  /** `YYYY-MM-DD` of the daily note the memo lives in. */
  date: string;
  /** Raw markdown body of the memo, without the `- HH:MM` prefix. */
  text: string;
}

/**
 * One piece of an assistant reply: either prose or a tool call.
 *
 * Lives here rather than in `chat-runtime` on purpose. This module is
 * Obsidian-free and already value-imported by `chat-pane`, whereas
 * `chat-runtime` is desktop-only and may only ever be reached through a
 * dynamic import — putting a shared type there invites a value-import that
 * would break the plugin's load on mobile.
 */
export type MessageBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      /** The CLI's tool_use id; matches a call to its result. */
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Absent while the tool is still running, or if the turn was stopped. */
      result?: string;
      isError?: boolean;
    };

export interface ChatMessage {
  role: 'user' | 'assistant';
  /**
   * Plain text of the message. Always present and always a string, including
   * when `blocks` is set, where it holds their readable flattening — that
   * invariant is what lets an older build read a newer file without dropping
   * the message (see `parseConversation`).
   */
  content: string;
  /** Epoch ms. */
  timestamp: number;
  /** Structured blocks, on assistant turns that called tools. */
  blocks?: MessageBlock[];
}

export interface Conversation {
  id: string;
  /** Derived from the first user message; falls back to the seed memo. */
  title: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms, bumped on every save. Drives list ordering. */
  updatedAt: number;
  /**
   * Session id held by the claude CLI, used for `--resume`. Null until the
   * first turn completes, and stale once the CLI expires its own transcript —
   * in which case the turn fails and a fresh session is started.
   */
  cliSessionId: string | null;
  seed: ChatSeed;
  messages: ChatMessage[];
  /** Model this thread uses. Empty means "whatever the setting says". */
  model: string;
  /** Permission mode this thread uses. Empty means "whatever the setting says". */
  permissionMode: string;
  /** Context tokens reported by the last completed turn; 0 before any. */
  contextTokens: number;
  /** Context window of the model that served the last turn; 0 before any. */
  contextWindow: number;
}

/** The slice of Obsidian's DataAdapter this module needs. */
export interface ChatStorageAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[] }>;
}

const CHATS_DIR = '.spark-memo/chats';
const TITLE_MAX = 24;

/** Trim a message down to a list-friendly title. */
export function deriveTitle(text: string): string {
  // Collapse whitespace so a multi-line memo doesn't produce a ragged title.
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat;
}

/** Build an empty conversation around a memo. */
export function createConversation(
  id: string,
  seed: ChatSeed,
  now: number,
  model: string,
  permissionMode = '',
): Conversation {
  return {
    id,
    title: deriveTitle(seed.text),
    createdAt: now,
    updatedAt: now,
    cliSessionId: null,
    seed,
    messages: [],
    model,
    permissionMode,
    contextTokens: 0,
    contextWindow: 0,
  };
}

/** Longest tool result kept on disk; threads live in the synced vault. */
const MAX_PERSISTED_RESULT = 4096;

/**
 * Readable plain text for a block list, stored alongside it as `content`.
 *
 * Keeping that field a faithful flattening is what lets an older build open a
 * newer file: it validates as a string, renders sensibly, and `deriveTitle`
 * keeps working. Tool calls collapse to a one-line marker.
 */
export function flattenBlocks(blocks: MessageBlock[]): string {
  return blocks
    .map(b => (b.kind === 'text' ? b.text : `\`${b.name}(${firstArg(b.input)})\``))
    .filter(s => s.length > 0)
    .join('\n');
}

function firstArg(input: Record<string, unknown>): string {
  const first = Object.values(input).find(v => typeof v === 'string');
  return typeof first === 'string' ? first.slice(0, 60) : '';
}

/**
 * Validate a stored `blocks` array, block by block.
 *
 * Leniency is the point: a bad block is dropped, the rest of the message
 * survives, and a malformed array never costs the message — its `content` is
 * still a valid rendering of the whole turn.
 */
function parseBlocks(raw: unknown): MessageBlock[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const blocks: MessageBlock[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const b = item as Record<string, unknown>;
    if (b.kind === 'text') {
      if (typeof b.text === 'string') blocks.push({ kind: 'text', text: b.text });
      continue;
    }
    if (b.kind !== 'tool') continue;
    if (typeof b.id !== 'string' || typeof b.name !== 'string') continue;
    blocks.push({
      kind: 'tool',
      id: b.id,
      name: b.name,
      input:
        typeof b.input === 'object' && b.input !== null
          ? (b.input as Record<string, unknown>)
          : {},
      ...(typeof b.result === 'string' ? { result: b.result } : {}),
      ...(typeof b.isError === 'boolean' ? { isError: b.isError } : {}),
    });
  }
  return blocks.length > 0 ? blocks : undefined;
}

/** Shrink oversized tool results before they hit disk. */
function trimBlocksForDisk(blocks: MessageBlock[]): MessageBlock[] {
  return blocks.map(b => {
    if (b.kind !== 'tool' || b.result === undefined) return b;
    if (b.result.length <= MAX_PERSISTED_RESULT) return b;
    return { ...b, result: `${b.result.slice(0, MAX_PERSISTED_RESULT)}\n…` };
  });
}

/**
 * Coerce parsed JSON into a Conversation, or null when it is unusable.
 *
 * Files here are hand-editable and sync-visible, so a truncated or
 * half-written one is a real possibility. Anything that fails validation is
 * skipped rather than crashing the list.
 */
export function parseConversation(raw: unknown): Conversation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const seed = obj.seed as Record<string, unknown> | undefined;

  if (typeof obj.id !== 'string' || obj.id.length === 0) return null;
  if (!seed || typeof seed.text !== 'string') return null;

  const messages: ChatMessage[] = Array.isArray(obj.messages)
    ? (obj.messages as unknown[]).flatMap(item => {
        if (typeof item !== 'object' || item === null) return [];
        const m = item as Record<string, unknown>;
        if (m.role !== 'user' && m.role !== 'assistant') return [];
        if (typeof m.content !== 'string') return [];
        const blocks = parseBlocks(m.blocks);
        return [
          {
            role: m.role,
            content: m.content,
            timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0,
            ...(blocks ? { blocks } : {}),
          },
        ];
      })
    : [];

  const createdAt = typeof obj.createdAt === 'number' ? obj.createdAt : 0;

  return {
    id: obj.id,
    title: typeof obj.title === 'string' ? obj.title : deriveTitle(String(seed.text)),
    createdAt,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : createdAt,
    cliSessionId: typeof obj.cliSessionId === 'string' ? obj.cliSessionId : null,
    seed: {
      timestamp: typeof seed.timestamp === 'string' ? seed.timestamp : '',
      date: typeof seed.date === 'string' ? seed.date : '',
      text: seed.text,
    },
    messages,
    // Absent in files written before per-thread models existed; an empty
    // string falls back to the current setting at send time.
    model: typeof obj.model === 'string' ? obj.model : '',
    permissionMode: typeof obj.permissionMode === 'string' ? obj.permissionMode : '',
    contextTokens: typeof obj.contextTokens === 'number' ? obj.contextTokens : 0,
    contextWindow: typeof obj.contextWindow === 'number' ? obj.contextWindow : 0,
  };
}

export class ChatStore {
  private readonly adapter: ChatStorageAdapter;

  constructor(adapter: ChatStorageAdapter) {
    this.adapter = adapter;
  }

  private pathFor(id: string): string {
    return `${CHATS_DIR}/${id}.json`;
  }

  /** Create the storage folder if it isn't there yet. */
  private async ensureDir(): Promise<void> {
    if (await this.adapter.exists(CHATS_DIR)) return;
    // Obsidian's mkdir is not recursive, so the parent goes first.
    if (!(await this.adapter.exists('.spark-memo'))) {
      await this.adapter.mkdir('.spark-memo');
    }
    await this.adapter.mkdir(CHATS_DIR);
  }

  /** Write one conversation, stamping `updatedAt`. */
  async save(conversation: Conversation, now: number): Promise<void> {
    conversation.updatedAt = now;
    await this.ensureDir();
    // Trim only the copy being written: the in-memory blocks stay whole so the
    // open thread keeps showing what it already rendered.
    const onDisk = {
      ...conversation,
      messages: conversation.messages.map(m =>
        m.blocks ? { ...m, blocks: trimBlocksForDisk(m.blocks) } : m,
      ),
    };
    await this.adapter.write(this.pathFor(conversation.id), JSON.stringify(onDisk, null, 2));
  }

  async delete(id: string): Promise<void> {
    const path = this.pathFor(id);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  /**
   * Load every conversation, newest first. Unreadable or malformed files are
   * skipped so one bad file can't hide the rest.
   */
  async loadAll(): Promise<Conversation[]> {
    if (!(await this.adapter.exists(CHATS_DIR))) return [];

    let listing: { files: string[] };
    try {
      listing = await this.adapter.list(CHATS_DIR);
    } catch {
      return [];
    }

    const out: Conversation[] = [];
    for (const file of listing.files) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = parseConversation(JSON.parse(await this.adapter.read(file)));
        // A thread with no messages carries nothing to come back to. These
        // only exist as leftovers from before threads were committed on first
        // send; skipping them keeps empty rows out of the list.
        if (parsed && parsed.messages.length > 0) out.push(parsed);
      } catch {
        // Corrupt or mid-write file — skip it.
      }
    }

    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }
}
