/**
 * Chat runtime — drives the locally installed `claude` CLI as a subprocess and
 * turns its NDJSON stream into a flat sequence of ChatChunks.
 *
 * DESKTOP ONLY. This is the single module in the plugin that touches Node, so
 * it must never be reached on mobile. Two rules keep that true:
 *   1. `child_process` / `fs` are pulled in via `require()` *inside* functions,
 *      never as a top-level import — a top-level one would make esbuild emit a
 *      module-scope require that throws the moment the plugin loads on mobile,
 *      taking the whole plugin down with it.
 *   2. Callers must reach this file through `await import('./chat-runtime')`
 *      behind a `Platform.isDesktopApp` guard.
 *
 * Why the CLI and not the HTTP API: it reuses the user's existing Claude Code
 * login, so there is no API key to store anywhere in the vault.
 */

/** One event from the runtime. Mirrors the shape used by the chat pane. */
export type ChatChunk =
  /** Emitted once per turn as soon as the CLI reports its session id. */
  | { type: 'session'; id: string }
  /** An incremental slice of assistant text. */
  | { type: 'text'; content: string }
  /** Context usage, reported once at the end of a turn. */
  | { type: 'usage'; contextTokens: number; contextWindow: number }
  /** Terminal failure for this turn; no 'done' follows. */
  | { type: 'error'; content: string }
  /** Turn finished cleanly. */
  | { type: 'done' };

/** An image sent inline with a message. */
export interface ChatImage {
  /** e.g. image/jpeg */
  mediaType: string;
  /** Raw base64, no data: prefix. */
  data: string;
}

export interface StreamOptions {
  /** The user's message for this turn. */
  prompt: string;
  /** Images to attach to this message. */
  images?: ChatImage[];
  /** Working directory for the subprocess (the vault root). */
  cwd: string;
  /** Absolute path to the `claude` binary. */
  cliPath: string;
  /** Model alias or full name, e.g. 'sonnet'. */
  model: string;
  /** System prompt replacing Claude Code's coding-agent default. */
  systemPrompt: string;
  /**
   * Existing CLI session to continue. Omit on the first turn — the caller then
   * supplies `newSessionId` and the CLI adopts it.
   */
  resumeSessionId?: string;
  /** UUID to assign to a brand-new session. Ignored when resuming. */
  newSessionId?: string;
}

/** Handle returned by {@link streamClaude} so the caller can stop a turn. */
export interface StreamHandle {
  chunks: AsyncGenerator<ChatChunk>;
  /** Kill the subprocess. Safe to call after the turn already ended. */
  abort(): void;
}

/**
 * Where `claude` usually lands, in the order we probe. Obsidian on macOS is
 * launched by Finder rather than a shell, so its PATH is the bare system one
 * and a plain `spawn('claude')` fails with ENOENT even when the binary is on
 * the user's interactive PATH. Probing absolute paths sidesteps that entirely.
 */
const CANDIDATE_PATHS = [
  '~/.local/bin/claude',
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '~/.bun/bin/claude',
  '~/.npm-global/bin/claude',
];

/**
 * Locate the `claude` binary.
 *
 * @param configured Absolute path from settings; when non-empty it wins and is
 *   only checked for existence, so a wrong value surfaces as a clear error
 *   instead of silently falling back to some other install.
 * @returns Absolute path, or null when nothing was found.
 */
/**
 * How long a finished turn's process may take to exit on its own before we
 * start killing it, and how long SIGTERM gets before SIGKILL. Generous on
 * purpose: the CLI writes its session transcript on the way out, and that is
 * what `--resume` reads back.
 */
const REAP_GRACE_MS = 10_000;
const FORCE_KILL_DELAY_MS = 5_000;

export function resolveClaudePath(configured: string): string | null {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');

  const expand = (p: string) =>
    p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;

  const candidates = configured.trim().length > 0 ? [configured.trim()] : CANDIDATE_PATHS;
  for (const candidate of candidates) {
    const full = expand(candidate);
    try {
      if (fs.existsSync(full)) return full;
    } catch {
      // Unreadable path — treat as absent and keep probing.
    }
  }
  return null;
}

/**
 * Flags that strip Claude Code down to a plain conversational model.
 *
 * Without these the CLI loads the user's full coding setup — MCP servers,
 * skills, hooks, CLAUDE.md — which measured at ~27k input tokens for a
 * three-word prompt. With them it is ~200. Each flag pulls its own weight:
 *   --tools ""                disables every built-in tool
 *   --strict-mcp-config + --mcp-config  drops all MCP servers
 *   --setting-sources ""      skips user/project settings, hooks, CLAUDE.md
 *   --system-prompt           replaces the coding-agent prompt wholesale
 *
 * The message itself goes in over stdin as stream-json rather than as a `-p`
 * argument. That is the only way to attach images, and using one path for
 * every turn keeps text-only and image-bearing turns from drifting apart.
 */
function buildArgs(opts: StreamOptions): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--system-prompt',
    opts.systemPrompt,
    '--model',
    opts.model,
  ];

  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  else if (opts.newSessionId) args.push('--session-id', opts.newSessionId);

  return args;
}

/**
 * Run one turn and stream it back.
 *
 * The generator yields text as it arrives and always terminates with exactly
 * one 'done' or one 'error'. Failures are reported as chunks rather than
 * thrown, so callers can render them inline without a try/catch around the
 * consuming loop.
 */
export function streamClaude(opts: StreamOptions): StreamHandle {
  const { spawn } = require('child_process') as typeof import('child_process');

  // Note: deliberately not passing an AbortSignal to spawn(). Obsidian's
  // Electron runtime evaluates AbortSignal in a different realm, so Node's
  // internal `instanceof EventTarget` check fails and spawn throws. We keep a
  // handle on the child and kill it manually instead.
  const child = spawn(opts.cliPath, buildArgs(opts), {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Send the turn, then close stdin so the CLI knows no more input follows and
  // ends the turn on its own.
  const content: Array<Record<string, unknown>> = [];
  for (const image of opts.images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }
  content.push({ type: 'text', text: opts.prompt });

  // A stdin stream with no 'error' listener turns EPIPE (child died early)
  // into an uncaught exception that would take down the renderer. The real
  // failure is reported by the 'close' handler below, so swallow it here.
  child.stdin.on('error', () => {});

  try {
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
    child.stdin.end();
  } catch {
    // Same as above — reported via 'error'/'close'.
  }

  /** Queued chunks waiting to be pulled, plus the generator's parked resolver. */
  const pending: ChatChunk[] = [];
  let resolveNext: ((chunk: ChatChunk | null) => void) | null = null;
  let finished = false;
  let aborted = false;
  /** Set once we emit an error so the exit handler doesn't append a second one. */
  let errored = false;

  const push = (chunk: ChatChunk) => {
    if (finished) return;
    if (chunk.type === 'error') errored = true;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(chunk);
    } else {
      pending.push(chunk);
    }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(null);
    }
  };

  // ── stdout: NDJSON, one JSON object per line ──
  // Chunk boundaries fall anywhere, so hold a remainder between 'data' events.
  let stdoutBuf = '';
  let sessionSent = false;

  child.stdout.on('data', (data: Buffer) => {
    stdoutBuf += data.toString('utf8');
    const lines = stdoutBuf.split('\n');
    // Last element is an incomplete line (or '' when the chunk ended on \n).
    stdoutBuf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Non-JSON noise on stdout — ignore rather than kill the turn.
        continue;
      }

      // Session id shows up on nearly every event; take the first one.
      if (!sessionSent && typeof event.session_id === 'string') {
        sessionSent = true;
        push({ type: 'session', id: event.session_id });
      }

      // Token-level text arrives as content_block_delta inside stream_event.
      // We read only these; the fully-assembled `assistant` events that follow
      // would duplicate the same text.
      if (event.type === 'stream_event') {
        const inner = event.event as Record<string, unknown> | undefined;
        if (inner?.type === 'content_block_delta') {
          const delta = inner.delta as Record<string, unknown> | undefined;
  /** Pending reaper timers, cleared the moment the child actually exits. */
  let reapTimer: ReturnType<typeof setTimeout> | null = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReapTimers = () => {
    if (reapTimer !== null) {
      clearTimeout(reapTimer);
      reapTimer = null;
    }
    if (forceTimer !== null) {
      clearTimeout(forceTimer);
      forceTimer = null;
    }
  };

  const killChild = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  };

  /** SIGTERM, then insist if the process is wedged and ignores it. */
  const killWithForceFallback = () => {
    killChild('SIGTERM');
    forceTimer = setTimeout(() => killChild('SIGKILL'), FORCE_KILL_DELAY_MS);
  };

  /**
   * The stream is done, but the process may still be flushing its session
   * transcript, which `--resume` reads back. Killing it here would truncate
   * that, so give it room to leave on its own and only step in if it doesn't.
   *
   * Normally nothing fires: stdin was closed with the turn, so the CLI exits
   * within moments and 'close' clears these timers. This only matters when
   * something wedges it open (a hung MCP server, say), which would otherwise
   * strand the process with no way left to kill it.
   */
  const scheduleReap = () => {
    clearReapTimers();
    reapTimer = setTimeout(killWithForceFallback, REAP_GRACE_MS);
  };

          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            push({ type: 'text', content: delta.text });
          }
        }
        continue;
      }

      if (event.type === 'result') {
    scheduleReap();
        // Context usage is the sum of fresh input and both cache buckets; the
        // window comes from whichever model actually served the turn.
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          const contextTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0);
          const modelUsage = event.modelUsage as
            | Record<string, { contextWindow?: number }>
            | undefined;
          const contextWindow = modelUsage
            ? (Object.values(modelUsage)[0]?.contextWindow ?? 0)
            : 0;
          if (contextTokens > 0) push({ type: 'usage', contextTokens, contextWindow });
        }

        if (event.is_error === true) {
          const detail =
            typeof event.result === 'string' && event.result.length > 0
              ? event.result
              : String(event.subtype ?? 'unknown error');
          push({ type: 'error', content: detail });
        } else {
          push({ type: 'done' });
        }
        finish();
      }
    }
  });

  // stderr is captured only to make a non-zero exit explainable.
  let stderrBuf = '';
  child.stderr.on('data', (data: Buffer) => {
    // Cap it — a runaway process shouldn't grow this without bound.
    if (stderrBuf.length < 8192) stderrBuf += data.toString('utf8');
  });

  child.on('error', (err: Error) => {
    push({ type: 'error', content: err.message });
    finish();
  });

  child.on('close', (code: number | null) => {
    if (finished) return;
    // A clean 'result' event already finished the turn above; reaching here
    // means the process died without one.
    if (aborted) {
      push({ type: 'done' });
    } else if (!errored) {
      const detail = stderrBuf.trim().split('\n').slice(-3).join('\n');
      push({
        type: 'error',
        content: detail.length > 0 ? detail : `claude exited with code ${code ?? 'unknown'}`,
      });
    }
    finish();
  });

  async function* generate(): AsyncGenerator<ChatChunk> {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift() as ChatChunk;
        continue;
      }
      if (finished) return;
      const next = await new Promise<ChatChunk | null>(resolve => {
        resolveNext = resolve;
      });
      if (next === null) return;
      yield next;
    }
  }

  return {
    chunks: generate(),
    abort() {
      aborted = true;
      clearReapTimers();
      killWithForceFallback();
    },
  };
}
    clearReapTimers();
    // No `finished` guard: the stream ending does not mean the process did,
    // and this is the only way a caller can reach the child. Bailing out here
    // once the turn was over used to leave a wedged process unkillable.
