/**
 * Session plugin — auto-save sessions to disk and provide /resume command.
 *
 * Features:
 *   - Auto-save session state on terminal events and durable-safe progress points
 *   - `/resume` command lists past sessions with summary info
 *   - Session picker overlay for arrow-key selection
 *   - Crash recovery: detect sessions without a terminal event on startup
 *   - Auto-cleanup: keep last 50 sessions, delete older ones
 *
 * Pure helper functions are exported for testing.
 */

import { readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import type { InlinePlugin, PluginContext } from '@nerax-ai/plugin';
import type { TuiFactoryMap, TuiExtensionType, CommandDef, CommandContext } from '../types/tui-plugin.js';
import { TUI_COMMAND } from '../types/tui-plugin.js';
import { createDefaultSessionStore, type SessionStore } from '../session-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { TurnEntry } from '../types/tui-state.js';

export interface MessageSnapshot {
  turns: TurnEntry[];
  currentText?: string;
  currentThinking?: string;
}

/** Metadata persisted alongside the message history for each session. */
export interface SessionMetadata {
  /** Unique session identifier. */
  sessionId: string;
  /** Model name used for this session. */
  model: string;
  /** ISO timestamp of when the session started. */
  startTime: string;
  /** First user message (used as session summary). */
  lastUserMessage: string;
  /** Session completion status. */
  status: 'completed' | 'crashed';
  /** Serialized message history (full turns array for TUI display). */
  messages: TurnEntry[];
  /** Agent messages with expanded skill content for session restore. */
  agentMessages?: unknown[];
}

/** Summary info used in session listing (without full messages). */
export interface SessionSummary {
  sessionId: string;
  model: string;
  startTime: string;
  lastUserMessage: string;
  status: 'completed' | 'crashed';
}

/** Dependencies injected into the session plugin. */
export interface SessionPluginDeps {
  /** Get the current session ID from the store. */
  getSessionId: () => string;
  /** Get the current messages (full turns array) from the store. */
  getMessages: () => TurnEntry[];
  /** Get the model name. */
  getModel: () => string;
  /** Called to open the session picker overlay. */
  openSessionPicker?: () => void;
  /** Called to restore a session by ID. */
  onRestoreSession?: (sessionId: string) => void;
  /** Storage boundary for production and tests. */
  sessionStore?: SessionStore;
  /** Logger for diagnostics. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DIR = 'sessions';
const MAX_SESSIONS = 50;
const SESSION_FILE_PREFIX = 'sess_';
const SESSION_FILE_SUFFIX = '.json';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Get the full path to the sessions directory.
 */
export function getSessionsDir(statePath: string): string {
  return join(statePath, SESSIONS_DIR);
}

/**
 * Build a session filename from a session ID.
 */
export function sessionFilename(sessionId: string): string {
  return `${sessionId}${SESSION_FILE_SUFFIX}`;
}

/**
 * Extract session ID from a filename.
 */
export function sessionIdFromFilename(filename: string): string | null {
  if (filename.startsWith(SESSION_FILE_PREFIX) && filename.endsWith(SESSION_FILE_SUFFIX)) {
    return filename.slice(0, -SESSION_FILE_SUFFIX.length);
  }
  return null;
}

/**
 * Create session metadata from current state.
 */
export function buildSessionMetadata(
  sessionId: string,
  model: string,
  messages: TurnEntry[],
  status: 'completed' | 'crashed',
  startTime: string,
  agentMessages?: unknown[],
): SessionMetadata {
  return {
    sessionId,
    model,
    startTime,
    lastUserMessage: extractFirstUserMessage(messages),
    status,
    messages,
    agentMessages,
  };
}

/**
 * Convert the live message state into a persisted display history.
 * In-progress text is copied into the snapshot without mutating the store.
 */
export function snapshotTurns(messages: MessageSnapshot, timestamp = Date.now()): TurnEntry[] {
  const turns = [...messages.turns];
  if (messages.currentThinking) {
    turns.push({
      role: 'assistant',
      content: `Thinking:\n${messages.currentThinking}`,
      timestamp,
    });
  }
  if (messages.currentText) {
    turns.push({
      role: 'assistant',
      content: messages.currentText,
      timestamp,
    });
  }
  return turns;
}

/**
 * Extract the first user message from the turns array for a summary.
 * Returns a truncated version (first 80 chars) of the first assistant turn content.
 */
export function extractFirstUserMessage(messages: TurnEntry[]): string {
  if (!messages || messages.length === 0) return '(empty)';
  const firstContent = messages[0].content;
  if (!firstContent) return '(empty)';
  const lines = firstContent.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return '(empty)';
  const first = lines[0].trim();
  return first.length > 80 ? first.slice(0, 77) + '...' : first;
}

/**
 * Convert full metadata to a summary (without the heavy messages field).
 */
export function metadataToSummary(meta: SessionMetadata): SessionSummary {
  return {
    sessionId: meta.sessionId,
    model: meta.model,
    startTime: meta.startTime,
    lastUserMessage: meta.lastUserMessage,
    status: meta.status,
  };
}

/**
 * Sort session filenames by modification time (newest first).
 * Returns a sorted array of filenames.
 */
export async function listSessionFiles(sessionsDir: string): Promise<string[]> {
  try {
    await mkdir(sessionsDir, { recursive: true });
    const files = await readdir(sessionsDir);
    const sessionFiles = files.filter(
      (f) => f.startsWith(SESSION_FILE_PREFIX) && f.endsWith(SESSION_FILE_SUFFIX),
    );
    // Return sorted by filename (which contains timestamp, newest last in name, so reverse)
    // Filenames are sess_TIMESTAMP_RANDOM.json, so lexicographic sort works
    return sessionFiles.sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Clean up old session files, keeping only the most recent MAX_SESSIONS.
 * Returns the number of deleted files.
 */
export async function cleanupOldSessions(
  sessionsDir: string,
  maxSessions: number = MAX_SESSIONS,
  deleteFn?: (path: string) => Promise<void>,
): Promise<number> {
  const files = await listSessionFiles(sessionsDir);
  if (files.length <= maxSessions) return 0;

  const toDelete = files.slice(maxSessions);
  const del = deleteFn ?? defaultDeleteFn;
  let deleted = 0;
  for (const file of toDelete) {
    try {
      await del(join(sessionsDir, file));
      deleted++;
    } catch {
      // Skip files that can't be deleted
    }
  }
  return deleted;
}

/**
 * Find sessions that appear to have crashed (status: 'crashed' or file exists
 * but no valid status). Returns summaries sorted newest first.
 */
export async function findCrashedSessions(
  sessionsDir: string,
  readJSONFn?: (path: string) => Promise<SessionMetadata | undefined>,
): Promise<SessionSummary[]> {
  const files = await listSessionFiles(sessionsDir);
  const readJSON = readJSONFn ?? defaultReadJSONFn;
  const crashed: SessionSummary[] = [];

  for (const file of files) {
    try {
      const meta = await readJSON(join(sessionsDir, file));
      if (meta && meta.status === 'crashed') {
        crashed.push(metadataToSummary(meta));
      }
    } catch {
      // Skip corrupted files
    }
  }

  return crashed;
}

/**
 * Format a session summary for display in the session picker.
 */
export function formatSessionLine(summary: SessionSummary, index: number): string {
  const time = new Date(summary.startTime).toLocaleString();
  const statusIcon = summary.status === 'completed' ? 'OK' : '!!';
  const msg = summary.lastUserMessage;
  return `  ${index + 1}. [${statusIcon}] ${time} | ${msg}`;
}

// ---------------------------------------------------------------------------
// Default I/O functions (use @nerax-ai/storage)
// ---------------------------------------------------------------------------

async function defaultDeleteFn(path: string): Promise<void> {
  const { unlink } = await import('fs/promises');
  await unlink(path);
}

async function defaultReadJSONFn(_path: string): Promise<SessionMetadata | undefined> {
  // Default uses storage — but for testing this will be overridden
  return undefined;
}

// ---------------------------------------------------------------------------
// Session persistence operations
// ---------------------------------------------------------------------------

/**
 * Save a session to disk.
 */
export async function saveSession(
  sessionsDir: string,
  metadata: SessionMetadata,
  writeJSONFn: (path: string, data: unknown) => Promise<void>,
): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, sessionFilename(metadata.sessionId));
  await writeJSONFn(filePath, metadata);
}

/**
 * Load a session from disk.
 */
export async function loadSession(
  sessionsDir: string,
  sessionId: string,
  readJSONFn: (path: string) => Promise<SessionMetadata | undefined>,
): Promise<SessionMetadata | null> {
  try {
    const filePath = join(sessionsDir, sessionFilename(sessionId));
    const meta = await readJSONFn(filePath);
    return meta ?? null;
  } catch {
    return null;
  }
}

/**
 * List all session summaries (newest first).
 */
export async function listSessions(
  sessionsDir: string,
  readJSONFn: (path: string) => Promise<SessionMetadata | undefined>,
): Promise<SessionSummary[]> {
  const files = await listSessionFiles(sessionsDir);
  const summaries: SessionSummary[] = [];

  for (const file of files) {
    try {
      const meta = await readJSONFn(join(sessionsDir, file));
      if (meta) {
        summaries.push(metadataToSummary(meta));
      }
    } catch {
      // Skip corrupted files
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Standalone auto-save handler
// ---------------------------------------------------------------------------

/**
 * Create an auto-save handler that persists sessions on terminal events and
 * on durable-safe progress points. Non-terminal saves are marked crashed so a
 * later completed save can overwrite them.
 *
 * This is a standalone function that takes explicit dependencies — no plugin
 * instance is needed, avoiding the P1-14 issue of creating a second plugin
 * with an independent `sessionStartTime`.
 */
export function createAutoSaveHandler(deps: {
  getSessionId: () => string;
  getMessages: () => TurnEntry[];
  getMessageSnapshot?: () => MessageSnapshot;
  getAgentMessages: () => unknown[];
  getModel: () => string;
  sessionsDir?: string;
  sessionStore?: SessionStore;
  startTime: string;
}): (eventType: string) => Promise<void> {
  const { getSessionId, getMessages, getMessageSnapshot, getAgentMessages, getModel, sessionsDir, sessionStore, startTime } = deps;

  return async (eventType: string): Promise<void> => {
    const status = autoSaveStatusForEvent(eventType);
    if (!status) return;

    const sessionId = getSessionId();
    const messages = getMessageSnapshot ? snapshotTurns(getMessageSnapshot()) : getMessages();
    const agentMsgs = getAgentMessages();
    const model = getModel();

    const metadata = buildSessionMetadata(
      sessionId,
      model,
      messages,
      status,
      startTime,
      agentMsgs,
    );

    try {
      if (sessionStore) {
        await sessionStore.write(metadata);
        await sessionStore.cleanup(MAX_SESSIONS);
        return;
      }

      if (sessionsDir) {
        await saveSession(sessionsDir, metadata, async (path, data) => {
          const { writeFile } = await import('fs/promises');
          await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
        });

        // Cleanup old sessions
        await cleanupOldSessions(sessionsDir);
      }
    } catch {
      // Silently ignore save failures — auto-save is best-effort
    }
  };
}

function autoSaveStatusForEvent(eventType: string): 'completed' | 'crashed' | null {
  if (eventType === 'done') return 'completed';
  if (eventType === 'error') return 'crashed';
  if (eventType === 'turn_start' || eventType === 'turn_end' || eventType === 'tool_result') {
    return 'crashed';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Create the session plugin.
 * Accepts dependency injection for testability.
 */
export function sessionPlugin(
  deps: SessionPluginDeps,
): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  const {
    openSessionPicker,
    logger,
    sessionStore,
  } = deps;

  const log = logger ?? { info: () => {}, warn: () => {}, error: () => {} };

  return {
    manifest: {
      manifestVersion: 1,
      id: '@cortx/tui-session',
      name: 'TUI Session Persistence',
      version: '1.0.0',
      runtime: { main: 'inline' },
      description: 'Auto-save sessions and provide /resume command',
    },

    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>): void {
      // /resume command
      ctx.register(TUI_COMMAND, 'resume', () => ({
        name: '/resume',
        description: 'Resume a previous session',
        handler: async (_args: string, _cmdCtx: CommandContext) => {
          if (openSessionPicker) {
            openSessionPicker();
          } else {
            // Fallback: list sessions as text
            const store = sessionStore ?? createDefaultSessionStore();
            const summaries = await store.list();
            if (summaries.length === 0) {
              log.info('No previous sessions found.');
            } else {
              const lines = summaries.map((s, i) => formatSessionLine(s, i));
              log.info(['Previous sessions:', ...lines].join('\n'));
            }
          }
        },
      }) satisfies CommandDef);
    },
  };
}
