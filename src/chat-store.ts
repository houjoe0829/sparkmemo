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

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Epoch ms. */
  timestamp: number;
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
    contextTokens: 0,
    contextWindow: 0,
  };
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
        return [
          {
            role: m.role,
            content: m.content,
            timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0,
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
    await this.adapter.write(this.pathFor(conversation.id), JSON.stringify(conversation, null, 2));
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
