import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorageDir } from '@nerax-ai/storage';
import {
  getSessionsDir,
  sessionFilename,
  sessionIdFromFilename,
  buildSessionMetadata,
  extractFirstUserMessage,
  metadataToSummary,
  listSessionFiles,
  cleanupOldSessions,
  findCrashedSessions,
  formatSessionLine,
  saveSession,
  loadSession,
  listSessions,
  sessionPlugin,
  createAutoSaveHandler,
  snapshotTurns,
} from '../plugins/session-plugin.js';
import { createStorageSessionStore } from '../session-store.js';
import {
  filterSessions,
  moveSessionSelection,
  formatTime,
  truncate,
} from '../components/session-picker.js';
import { parseAgentMessages, turnsToMessages } from '../message-io.js';
import type { SessionMetadata, SessionSummary } from '../plugins/session-plugin.js';

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `cortx-test-sessions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helper: write a session file
// ---------------------------------------------------------------------------

async function writeSessionFile(
  dir: string,
  meta: SessionMetadata,
): Promise<string> {
  const filename = sessionFilename(meta.sessionId);
  const filePath = join(dir, filename);
  await writeFile(filePath, JSON.stringify(meta, null, 2), 'utf8');
  return filePath;
}

/** Create a test session metadata object. */
function makeMeta(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    sessionId: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    model: 'default',
    startTime: new Date().toISOString(),
    lastUserMessage: 'test message',
    status: 'completed',
    messages: [
      { role: 'assistant', content: 'test message\nHello world', timestamp: Date.now() },
    ],
    ...overrides,
  };
}

/** readJSON helper for tests — reads from a file path and parses JSON. */
function makeReadJSON(_dir: string) {
  return async (path: string): Promise<SessionMetadata | undefined> => {
    try {
      const data = await readFile(path, 'utf8');
      return JSON.parse(data) as SessionMetadata;
    } catch {
      return undefined;
    }
  };
}

/** writeJSON helper for tests. */
function makeWriteJSON() {
  return async (path: string, data: unknown): Promise<void> => {
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  };
}

// ---------------------------------------------------------------------------
// Pure helper function tests
// ---------------------------------------------------------------------------

describe('sessionFilename', () => {
  test('appends .json suffix', () => {
    expect(sessionFilename('sess_1234_abc')).toBe('sess_1234_abc.json');
  });
});

describe('sessionIdFromFilename', () => {
  test('extracts session ID from valid filename', () => {
    expect(sessionIdFromFilename('sess_1234_abc.json')).toBe('sess_1234_abc');
  });

  test('returns null for non-session files', () => {
    expect(sessionIdFromFilename('other.json')).toBeNull();
    expect(sessionIdFromFilename('sess_123.txt')).toBeNull();
    expect(sessionIdFromFilename('readme.md')).toBeNull();
  });
});

describe('getSessionsDir', () => {
  test('appends sessions subdirectory to state path', () => {
    expect(getSessionsDir('/tmp/cortx')).toBe(join('/tmp/cortx', 'sessions'));
  });
});

describe('extractFirstUserMessage', () => {
  test('returns first non-empty line from first turn', () => {
    const turns = [{ role: 'assistant', content: 'Hello world\nSecond line', timestamp: Date.now() }];
    expect(extractFirstUserMessage(turns)).toBe('Hello world');
  });

  test('truncates long messages to 80 chars', () => {
    const long = 'a'.repeat(100);
    const turns = [{ role: 'assistant', content: long, timestamp: Date.now() }];
    const result = extractFirstUserMessage(turns);
    expect(result.length).toBe(80);
    expect(result.endsWith('...')).toBe(true);
  });

  test('returns (empty) for empty array', () => {
    expect(extractFirstUserMessage([])).toBe('(empty)');
  });

  test('returns (empty) for whitespace-only content', () => {
    const turns = [{ role: 'assistant', content: '   \n  ', timestamp: Date.now() }];
    expect(extractFirstUserMessage(turns)).toBe('(empty)');
  });

  test('skips leading blank lines', () => {
    const turns = [{ role: 'assistant', content: '\n\nHello', timestamp: Date.now() }];
    expect(extractFirstUserMessage(turns)).toBe('Hello');
  });
});

describe('buildSessionMetadata', () => {
  test('builds metadata with extracted first user message', () => {
    const turns = [
      { role: 'assistant', content: 'Fix the bug\nin the auth module', timestamp: 1000 },
    ];
    const meta = buildSessionMetadata(
      'sess_123',
      'gpt-4',
      turns,
      'completed',
      '2026-04-19T10:00:00Z',
    );
    expect(meta.sessionId).toBe('sess_123');
    expect(meta.model).toBe('gpt-4');
    expect(meta.status).toBe('completed');
    expect(meta.startTime).toBe('2026-04-19T10:00:00Z');
    expect(meta.lastUserMessage).toBe('Fix the bug');
    expect(meta.messages).toEqual(turns);
  });
});

describe('metadataToSummary', () => {
  test('omits messages field', () => {
    const meta = makeMeta({ messages: [{ role: 'assistant', content: 'long content here', timestamp: Date.now() }] });
    const summary = metadataToSummary(meta);
    expect(summary.sessionId).toBe(meta.sessionId);
    expect(summary.model).toBe(meta.model);
    expect(summary.startTime).toBe(meta.startTime);
    expect(summary.lastUserMessage).toBe(meta.lastUserMessage);
    expect(summary.status).toBe(meta.status);
    expect((summary as any).messages).toBeUndefined();
  });
});

describe('formatSessionLine', () => {
  test('formats completed session with OK status', () => {
    const summary: SessionSummary = {
      sessionId: 'sess_123',
      model: 'default',
      startTime: '2026-04-19T10:00:00Z',
      lastUserMessage: 'fix the bug',
      status: 'completed',
    };
    const line = formatSessionLine(summary, 0);
    expect(line).toContain('[OK]');
    expect(line).toContain('fix the bug');
  });

  test('formats crashed session with !! status', () => {
    const summary: SessionSummary = {
      sessionId: 'sess_456',
      model: 'default',
      startTime: '2026-04-19T10:00:00Z',
      lastUserMessage: 'help me',
      status: 'crashed',
    };
    const line = formatSessionLine(summary, 2);
    expect(line).toContain('[!!]');
    expect(line).toContain('3.'); // index + 1
  });
});

// ---------------------------------------------------------------------------
// File I/O function tests (using temp directory)
// ---------------------------------------------------------------------------

describe('listSessionFiles', () => {
  test('returns empty array for non-existent directory', async () => {
    const files = await listSessionFiles(join(tempDir, 'nonexistent'));
    expect(files).toEqual([]);
  });

  test('returns session files sorted newest first', async () => {
    // Create sessions with increasing timestamps
    const meta1 = makeMeta({ sessionId: 'sess_100_a' });
    const meta2 = makeMeta({ sessionId: 'sess_200_b' });
    const meta3 = makeMeta({ sessionId: 'sess_300_c' });

    await writeSessionFile(tempDir, meta1);
    await writeSessionFile(tempDir, meta2);
    await writeSessionFile(tempDir, meta3);

    const files = await listSessionFiles(tempDir);
    expect(files.length).toBe(3);
    // Sorted newest first (lexicographic reverse)
    expect(files[0]).toBe('sess_300_c.json');
    expect(files[1]).toBe('sess_200_b.json');
    expect(files[2]).toBe('sess_100_a.json');
  });

  test('ignores non-session files', async () => {
    await writeFile(join(tempDir, 'other.txt'), 'hello', 'utf8');
    await writeFile(join(tempDir, 'readme.md'), '# Test', 'utf8');
    const meta = makeMeta({ sessionId: 'sess_100_a' });
    await writeSessionFile(tempDir, meta);

    const files = await listSessionFiles(tempDir);
    expect(files.length).toBe(1);
    expect(files[0]).toBe('sess_100_a.json');
  });
});

describe('saveSession', () => {
  test('writes session file to disk', async () => {
    const meta = makeMeta({ sessionId: 'sess_123_abc' });
    await saveSession(tempDir, meta, makeWriteJSON());

    const filePath = join(tempDir, 'sess_123_abc.json');
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    expect(data.sessionId).toBe('sess_123_abc');
    expect(data.messages).toEqual(meta.messages);
  });

  test('creates sessions directory if it does not exist', async () => {
    const nestedDir = join(tempDir, 'nested', 'sessions');
    const meta = makeMeta({ sessionId: 'sess_999' });
    await saveSession(nestedDir, meta, makeWriteJSON());

    const filePath = join(nestedDir, 'sess_999.json');
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    expect(data.sessionId).toBe('sess_999');
  });
});

describe('loadSession', () => {
  test('loads existing session', async () => {
    const meta = makeMeta({ sessionId: 'sess_load_1' });
    await writeSessionFile(tempDir, meta);

    const loaded = await loadSession(tempDir, 'sess_load_1', makeReadJSON(tempDir));
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('sess_load_1');
    expect(loaded!.messages).toEqual(meta.messages);
  });

  test('returns null for non-existent session', async () => {
    const loaded = await loadSession(tempDir, 'sess_nonexistent', makeReadJSON(tempDir));
    expect(loaded).toBeNull();
  });

  test('returns null for corrupted file', async () => {
    await writeFile(join(tempDir, 'sess_bad.json'), 'not valid json{{{', 'utf8');
    const loaded = await loadSession(tempDir, 'sess_bad', makeReadJSON(tempDir));
    expect(loaded).toBeNull();
  });
});

describe('StorageSessionStore', () => {
  test('writes, lists, loads, and cleans up through storage namespace', async () => {
    const sessionDir = createStorageDir(tempDir);
    const store = createStorageSessionStore(sessionDir);
    const first = makeMeta({ sessionId: 'sess_100_a', lastUserMessage: 'first' });
    const second = makeMeta({ sessionId: 'sess_200_b', lastUserMessage: 'second' });

    await store.write(first);
    await store.write(second);

    expect((await store.list()).map((s) => s.sessionId)).toEqual(['sess_200_b', 'sess_100_a']);
    expect((await store.read('sess_100_a'))?.lastUserMessage).toBe('first');
    expect(await store.cleanup(1)).toBe(1);
    expect((await store.list()).map((s) => s.sessionId)).toEqual(['sess_200_b']);
  });

  test('rejects traversal-like session ids through storage containment', async () => {
    const sessionDir = createStorageDir(tempDir);
    const store = createStorageSessionStore(sessionDir);

    await expect(store.write(makeMeta({ sessionId: '../escape' }))).rejects.toMatchObject({
      code: 'unsafe_path',
    });
  });
});

describe('listSessions', () => {
  test('returns summaries sorted newest first', async () => {
    const meta1 = makeMeta({ sessionId: 'sess_100_a', lastUserMessage: 'first' });
    const meta2 = makeMeta({ sessionId: 'sess_200_b', lastUserMessage: 'second' });

    await writeSessionFile(tempDir, meta1);
    await writeSessionFile(tempDir, meta2);

    const summaries = await listSessions(tempDir, makeReadJSON(tempDir));
    expect(summaries.length).toBe(2);
    expect(summaries[0].sessionId).toBe('sess_200_b');
    expect(summaries[1].sessionId).toBe('sess_100_a');
  });

  test('skips corrupted files gracefully', async () => {
    const meta = makeMeta({ sessionId: 'sess_good_1' });
    await writeSessionFile(tempDir, meta);
    await writeFile(join(tempDir, 'sess_bad.json'), '{{corrupt', 'utf8');

    const summaries = await listSessions(tempDir, makeReadJSON(tempDir));
    expect(summaries.length).toBe(1);
    expect(summaries[0].sessionId).toBe('sess_good_1');
  });

  test('returns empty array for empty directory', async () => {
    const summaries = await listSessions(tempDir, makeReadJSON(tempDir));
    expect(summaries).toEqual([]);
  });
});

describe('cleanupOldSessions', () => {
  test('deletes oldest sessions beyond maxSessions', async () => {
    // Create 5 sessions
    for (let i = 1; i <= 5; i++) {
      const meta = makeMeta({ sessionId: `sess_${i * 100}_x` });
      await writeSessionFile(tempDir, meta);
    }

    const deleted = await cleanupOldSessions(tempDir, 3);
    expect(deleted).toBe(2);

    const remaining = await listSessionFiles(tempDir);
    expect(remaining.length).toBe(3);
    // Newest 3 should remain
    expect(remaining[0]).toBe('sess_500_x.json');
  });

  test('does nothing when under limit', async () => {
    const meta = makeMeta({ sessionId: 'sess_100_a' });
    await writeSessionFile(tempDir, meta);

    const deleted = await cleanupOldSessions(tempDir, 50);
    expect(deleted).toBe(0);

    const remaining = await listSessionFiles(tempDir);
    expect(remaining.length).toBe(1);
  });

  test('does nothing with no sessions', async () => {
    const deleted = await cleanupOldSessions(tempDir, 50);
    expect(deleted).toBe(0);
  });
});

describe('findCrashedSessions', () => {
  test('finds sessions with crashed status', async () => {
    const crashed = makeMeta({
      sessionId: 'sess_crash_1',
      status: 'crashed',
      lastUserMessage: 'was doing something',
    });
    const completed = makeMeta({
      sessionId: 'sess_ok_1',
      status: 'completed',
    });
    await writeSessionFile(tempDir, crashed);
    await writeSessionFile(tempDir, completed);

    const results = await findCrashedSessions(tempDir, makeReadJSON(tempDir));
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBe('sess_crash_1');
    expect(results[0].status).toBe('crashed');
  });

  test('returns empty array when no crashed sessions', async () => {
    const completed = makeMeta({ sessionId: 'sess_ok_1', status: 'completed' });
    await writeSessionFile(tempDir, completed);

    const results = await findCrashedSessions(tempDir, makeReadJSON(tempDir));
    expect(results).toEqual([]);
  });

  test('returns empty array for empty directory', async () => {
    const results = await findCrashedSessions(tempDir, makeReadJSON(tempDir));
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createAutoSaveHandler tests
// ---------------------------------------------------------------------------

describe('createAutoSaveHandler', () => {
  test('snapshotTurns includes live streaming text without mutating turns', () => {
    const turns = [{ role: 'user', content: 'hello', timestamp: 1 }];
    const snapshot = snapshotTurns({
      turns,
      currentThinking: 'checking options',
      currentText: 'partial response',
    }, 2);

    expect(turns).toHaveLength(1);
    expect(snapshot).toEqual([
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: 'Thinking:\nchecking options', timestamp: 2 },
      { role: 'assistant', content: 'partial response', timestamp: 2 },
    ]);
  });

  test('writes session file on "done" event type', async () => {
    const sessionId = 'sess_autosave_done';
    const turns = [
      { role: 'assistant', content: 'Hello from done', timestamp: 1000 },
    ];

    const handler = createAutoSaveHandler({
      getSessionId: () => sessionId,
      getMessages: () => turns,
      getAgentMessages: () => [],
      getModel: () => 'default',
      sessionsDir: tempDir,
      startTime: '2026-04-19T10:00:00Z',
    });

    await handler('done');

    // Verify file was written
    const filePath = join(tempDir, sessionFilename(sessionId));
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    expect(data.sessionId).toBe(sessionId);
    expect(data.status).toBe('completed');
    expect(data.model).toBe('default');
    expect(data.messages).toEqual(turns);
    expect(data.agentMessages).toEqual([]);
  });

  test('writes session file on "error" event type', async () => {
    const sessionId = 'sess_autosave_err';
    const turns = [
      { role: 'assistant', content: 'Partial before crash', timestamp: 1000 },
    ];

    const handler = createAutoSaveHandler({
      getSessionId: () => sessionId,
      getMessages: () => turns,
      getAgentMessages: () => [{ role: 'user', content: 'hello' }],
      getModel: () => 'gpt-4',
      sessionsDir: tempDir,
      startTime: '2026-04-19T11:00:00Z',
    });

    await handler('error');

    const filePath = join(tempDir, sessionFilename(sessionId));
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    expect(data.sessionId).toBe(sessionId);
    expect(data.status).toBe('crashed');
    expect(data.model).toBe('gpt-4');
  });

  test('writes crashed snapshot on durable-safe non-terminal events', async () => {
    const sessionId = 'sess_autosave_checkpoint';
    const turns = [{ role: 'user', content: 'start', timestamp: 1 }];
    const handler = createAutoSaveHandler({
      getSessionId: () => sessionId,
      getMessages: () => turns,
      getMessageSnapshot: () => ({
        turns,
        currentText: 'working...',
      }),
      getAgentMessages: () => [],
      getModel: () => 'default',
      sessionsDir: tempDir,
      startTime: '2026-04-19T10:00:00Z',
    });

    await handler('tool_result');

    const filePath = join(tempDir, sessionFilename(sessionId));
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    expect(data.status).toBe('crashed');
    expect(data.messages).toEqual([
      { role: 'user', content: 'start', timestamp: 1 },
      expect.objectContaining({ role: 'assistant', content: 'working...' }),
    ]);
  });

  test('ignores noisy streaming event types', async () => {
    const sessionId = 'sess_autosave_skip';
    const handler = createAutoSaveHandler({
      getSessionId: () => sessionId,
      getMessages: () => [],
      getAgentMessages: () => [],
      getModel: () => 'default',
      sessionsDir: tempDir,
      startTime: '2026-04-19T10:00:00Z',
    });

    await handler('text_delta');
    await handler('tool_use');
    await handler('thinking_delta');

    // No session file should be written
    const files = await listSessionFiles(tempDir);
    expect(files).toEqual([]);
  });

  test('includes all turns in saved metadata', async () => {
    const sessionId = 'sess_autosave_turns';
    const turns = [
      { role: 'assistant', content: 'First turn', timestamp: 1000 },
      { role: 'assistant', content: 'Second turn', timestamp: 2000 },
      { role: 'assistant', content: 'Third turn', timestamp: 3000 },
    ];

    const handler = createAutoSaveHandler({
      getSessionId: () => sessionId,
      getMessages: () => turns,
      getAgentMessages: () => [{ role: 'user', content: 'test' }],
      getModel: () => 'default',
      sessionsDir: tempDir,
      startTime: '2026-04-19T12:00:00Z',
    });

    await handler('done');

    const filePath = join(tempDir, sessionFilename(sessionId));
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    expect(data.messages).toEqual(turns);
    expect(data.messages.length).toBe(3);
    expect(data.lastUserMessage).toBe('First turn');
    expect(data.agentMessages).toEqual([{ role: 'user', content: 'test' }]);
  });
});

// ---------------------------------------------------------------------------
// Session plugin factory tests
// ---------------------------------------------------------------------------

describe('sessionPlugin', () => {
  test('registers /resume command', () => {
    const plugin = sessionPlugin({
      getSessionId: () => 'sess_test',
      getMessages: () => [],
      getModel: () => 'default',
    });

    expect(plugin.manifest.id).toBe('@cortx/tui-session');

    // Verify setup registers a command
    const registered: { type: string; id: string }[] = [];
    plugin.setup({
      register: (type: string, id: string, _factory: any) => {
        registered.push({ type, id });
      },
    } as any);

    const resumeReg = registered.find((r) => r.id === 'resume');
    expect(resumeReg).toBeDefined();
    expect(resumeReg!.type).toBe('tui.command');
  });

  test('/resume command handler calls openSessionPicker when available', async () => {
    let pickerOpened = false;
    const plugin = sessionPlugin({
      getSessionId: () => 'sess_test',
      getMessages: () => [],
      getModel: () => 'default',
      openSessionPicker: () => { pickerOpened = true; },
    });

    let resumeCmd: any;
    plugin.setup({
      register: (_type: string, id: string, factory: any) => {
        if (id === 'resume') {
          resumeCmd = factory({} as any);
        }
      },
    } as any);

    expect(resumeCmd).toBeDefined();
    expect(resumeCmd.name).toBe('/resume');

    await resumeCmd.handler('', { args: '', abort: () => {} });
    expect(pickerOpened).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session restore message parsing tests
// ---------------------------------------------------------------------------

describe('message restore parsing', () => {
  test('converts legacy display turns to structured language messages', () => {
    const messages = turnsToMessages([
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: 'hi', timestamp: 2 },
      { role: 'tool', content: 'tool output', timestamp: 3 },
    ]);

    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  test('rejects malformed persisted agent messages', () => {
    const messages = parseAgentMessages([
      { role: 'user', content: 'legacy string is migrated here' },
      { role: 'assistant', content: [{ type: 'text', text: 'valid' }] },
      { role: 'tool', content: [{ type: 'text', text: 'wrong part' }] },
      { role: 'unknown', content: [] },
    ]);

    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'legacy string is migrated here' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'valid' }] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Session picker pure function tests
// ---------------------------------------------------------------------------

describe('filterSessions', () => {
  const sessions: SessionSummary[] = [
    {
      sessionId: 'sess_1',
      model: 'default',
      startTime: '2026-04-19T10:00:00Z',
      lastUserMessage: 'fix the bug in auth',
      status: 'completed',
    },
    {
      sessionId: 'sess_2',
      model: 'gpt-4',
      startTime: '2026-04-18T15:00:00Z',
      lastUserMessage: 'help me write tests',
      status: 'crashed',
    },
    {
      sessionId: 'sess_3',
      model: 'default',
      startTime: '2026-04-17T08:00:00Z',
      lastUserMessage: 'explain the architecture',
      status: 'completed',
    },
  ];

  test('empty filter returns all sessions', () => {
    expect(filterSessions(sessions, '')).toEqual(sessions);
  });

  test('filters by message content (case-insensitive)', () => {
    const result = filterSessions(sessions, 'bug');
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe('sess_1');
  });

  test('filters by model name', () => {
    const result = filterSessions(sessions, 'gpt-4');
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe('sess_2');
  });

  test('filters by status', () => {
    const result = filterSessions(sessions, 'crashed');
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe('sess_2');
  });

  test('returns empty array when no match', () => {
    expect(filterSessions(sessions, 'nonexistent')).toEqual([]);
  });

  test('returns empty array when filtering empty sessions', () => {
    expect(filterSessions([], 'test')).toEqual([]);
  });
});

describe('moveSessionSelection', () => {
  test('moves down from first to second', () => {
    expect(moveSessionSelection(0, 'down', 5)).toBe(1);
  });

  test('moves up from second to first', () => {
    expect(moveSessionSelection(1, 'up', 5)).toBe(0);
  });

  test('wraps down from last to first', () => {
    expect(moveSessionSelection(4, 'down', 5)).toBe(0);
  });

  test('wraps up from first to last', () => {
    expect(moveSessionSelection(0, 'up', 5)).toBe(4);
  });

  test('returns -1 for empty list', () => {
    expect(moveSessionSelection(0, 'down', 0)).toBe(-1);
    expect(moveSessionSelection(0, 'up', 0)).toBe(-1);
  });
});

describe('formatTime', () => {
  test('returns time string for today dates', () => {
    const today = new Date().toISOString();
    const result = formatTime(today);
    // Should be a short time string, not the full ISO string
    expect(result).not.toContain('T');
    expect(result.length).toBeLessThan(today.length);
  });

  test('returns formatted date for older dates', () => {
    const result = formatTime('2020-01-15T10:30:00Z');
    expect(result).toContain('Jan');
    expect(result).toContain('15');
  });
});

describe('truncate', () => {
  test('returns string unchanged when under max length', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  test('truncates and adds ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  test('returns exact length string unchanged', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });
});

// ---------------------------------------------------------------------------
// Integration: save -> list -> select -> restore flow
// ---------------------------------------------------------------------------

describe('Integration: save -> list -> select -> restore', () => {
  test('full session lifecycle', async () => {
    // 1. Save a session
    const turns = [
      { role: 'assistant', content: 'Help me fix the auth bug\nThe token validation is broken', timestamp: 1000 },
    ];
    const meta = makeMeta({
      sessionId: 'sess_integ_1',
      model: 'default',
      status: 'completed',
      messages: turns,
      lastUserMessage: 'Help me fix the auth bug',
      startTime: '2026-04-19T10:00:00Z',
    });

    await saveSession(tempDir, meta, makeWriteJSON());

    // 2. List sessions
    const summaries = await listSessions(tempDir, makeReadJSON(tempDir));
    expect(summaries.length).toBe(1);
    expect(summaries[0].sessionId).toBe('sess_integ_1');
    expect(summaries[0].lastUserMessage).toBe('Help me fix the auth bug');

    // 3. Load (restore) the session
    const loaded = await loadSession(tempDir, 'sess_integ_1', makeReadJSON(tempDir));
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('sess_integ_1');
    expect(loaded!.messages).toEqual(meta.messages);
    expect(loaded!.model).toBe('default');
    expect(loaded!.status).toBe('completed');

    // 4. Verify no crashed sessions
    const crashed = await findCrashedSessions(tempDir, makeReadJSON(tempDir));
    expect(crashed).toEqual([]);
  });

  test('crash recovery flow', async () => {
    // Save a crashed session
    const crashed = makeMeta({
      sessionId: 'sess_crashed_1',
      status: 'crashed',
      messages: [{ role: 'assistant', content: 'Something went wrong', timestamp: Date.now() }],
      lastUserMessage: 'Something went wrong',
      startTime: '2026-04-19T10:00:00Z',
    });
    await writeSessionFile(tempDir, crashed);

    // Find crashed sessions
    const results = await findCrashedSessions(tempDir, makeReadJSON(tempDir));
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBe('sess_crashed_1');

    // Load the crashed session
    const loaded = await loadSession(tempDir, 'sess_crashed_1', makeReadJSON(tempDir));
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('crashed');
  });

  test('50+ sessions cleanup flow', async () => {
    // Create 55 sessions
    for (let i = 1; i <= 55; i++) {
      const meta = makeMeta({
        sessionId: `sess_${String(i).padStart(4, '0')}_x`,
        status: i % 10 === 0 ? 'crashed' : 'completed',
        messages: [{ role: 'assistant', content: `Session ${i}`, timestamp: Date.now() }],
      });
      await writeSessionFile(tempDir, meta);
    }

    // Verify 55 files exist
    const filesBefore = await listSessionFiles(tempDir);
    expect(filesBefore.length).toBe(55);

    // Run cleanup (keep last 50)
    const deleted = await cleanupOldSessions(tempDir, 50);
    expect(deleted).toBe(5);

    // Verify 50 remain
    const filesAfter = await listSessionFiles(tempDir);
    expect(filesAfter.length).toBe(50);

    // Verify newest 50 remain (55, 54, ..., 6)
    expect(filesAfter[0]).toBe('sess_0055_x.json');
    expect(filesAfter[49]).toBe('sess_0006_x.json');
  });
});

// ---------------------------------------------------------------------------
// Session plugin auto-save simulation
// ---------------------------------------------------------------------------

describe('auto-save simulation', () => {
  test('save on done event, then list shows it', async () => {
    // Simulate what happens when agent completes a turn
    const sessionId = 'sess_autosave_1';
    const turns = [
      { role: 'assistant', content: 'The agent response text', timestamp: Date.now() },
    ];
    const meta = buildSessionMetadata(
      sessionId,
      'default',
      turns,
      'completed',
      '2026-04-19T10:00:00Z',
    );

    await saveSession(tempDir, meta, makeWriteJSON());

    const summaries = await listSessions(tempDir, makeReadJSON(tempDir));
    expect(summaries.length).toBe(1);
    expect(summaries[0].status).toBe('completed');
  });

  test('save on error event creates crashed session', async () => {
    const sessionId = 'sess_error_1';
    const turns = [
      { role: 'assistant', content: 'Partial response before error', timestamp: Date.now() },
    ];
    const meta = buildSessionMetadata(
      sessionId,
      'default',
      turns,
      'crashed',
      '2026-04-19T10:00:00Z',
    );

    await saveSession(tempDir, meta, makeWriteJSON());

    const crashed = await findCrashedSessions(tempDir, makeReadJSON(tempDir));
    expect(crashed.length).toBe(1);
    expect(crashed[0].sessionId).toBe('sess_error_1');
  });
});
