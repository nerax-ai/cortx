/**
 * Integration tests for critical TUI flows.
 *
 * These tests exercise the full pipeline: store + registry + processEvent,
 * verifying that state transitions, renderer extension invocation, Ctrl+C
 * handling, tool call lifecycle, and auto-save all work end-to-end.
 *
 * Uses real store and registry instances (not mocks) per project convention.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { TuiStore } from '../store.js';
import { TuiRegistry } from '../tui-registry.js';
import { processEvent } from '../renderer.js';
import { createAutoSaveHandler, sessionFilename } from '../plugins/session-plugin.js';
import type { AgentEvent } from '@cortx/sdk';
import { TUI_RENDERER } from '../types/tui-plugin.js';
import type {
  TuiExtensionType,
  TuiFactoryMap,
} from '../types/tui-plugin.js';
import type { InlinePlugin, PluginContext } from '@nerax-ai/plugin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal renderer plugin that records render calls. */
function createRecorderPlugin(
  id: string,
  eventType: string,
  calls: AgentEvent[],
): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  return {
    manifest: { id, name: id, version: '0.0.0' },
    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
      ctx.register(TUI_RENDERER, id, () => ({
        eventType,
        render: (event: AgentEvent) => {
          calls.push(event);
          return undefined;
        },
      }));
    },
  };
}

/** Create a renderer plugin that throws on every render call. */
function createThrowingPlugin(
  id: string,
  eventType: string,
): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  return {
    manifest: { id, name: id, version: '0.0.0' },
    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
      ctx.register(TUI_RENDERER, id, () => ({
        eventType,
        render: () => {
          throw new Error('renderer exploded');
        },
      }));
    },
  };
}

// Temp directory for auto-save tests
let tempDir: string;

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `cortx-integration-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// 1. Full agent turn lifecycle
// ---------------------------------------------------------------------------

describe('1. Full agent turn lifecycle', () => {
  test('turn_start -> text_delta*3 -> text -> done produces correct final state', async () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();

    // Verify initial state
    expect(store.getState().status).toBe('idle');
    expect(store.getState().messages.turns).toEqual([]);
    expect(store.getState().messages.currentText).toBe('');

    // 1. turn_start
    processEvent({ type: 'turn_start', iteration: 1 }, store, registry);
    expect(store.getState().status).toBe('running');
    expect(store.getState().iteration).toBe(1);

    // 2. Three text_delta events
    processEvent({ type: 'text_delta', delta: 'Hello' }, store, registry);
    processEvent({ type: 'text_delta', delta: ' brave' }, store, registry);
    processEvent({ type: 'text_delta', delta: ' world' }, store, registry);
    expect(store.getState().messages.currentText).toBe('Hello brave world');

    // 3. text event finalizes content
    processEvent({ type: 'text', content: 'Hello brave world!' }, store, registry);
    expect(store.getState().messages.currentText).toBe('Hello brave world!');

    // 4. done event
    processEvent(
      { type: 'done', usage: { inputTokens: 150, outputTokens: 75 } },
      store,
      registry,
    );

    // Verify final store state
    const state = store.getState();
    expect(state.status).toBe('idle');
    expect(state.messages.turns.length).toBe(1);
    expect(state.messages.turns[0].content).toBe('Hello brave world!');
    expect(state.messages.turns[0].role).toBe('assistant');
    expect(state.messages.currentText).toBe('');
    expect(state.tokenUsage).toEqual({ inputTokens: 150, outputTokens: 75 });
    expect(state.elapsed).toBe(0);

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-turn conversation accumulation
// ---------------------------------------------------------------------------

describe('2. Multi-turn conversation accumulation', () => {
  test('two full turn cycles accumulate turns and reset currentText', async () => {
    const store = new TuiStore();

    // --- Turn 1 ---
    processEvent({ type: 'turn_start', iteration: 1 }, store);
    processEvent({ type: 'text_delta', delta: 'hello' }, store);
    processEvent({ type: 'text', content: 'hello' }, store);
    processEvent({ type: 'done', usage: { inputTokens: 50, outputTokens: 20 } }, store);

    // Verify state after first turn
    expect(store.getState().status).toBe('idle');
    expect(store.getState().messages.currentText).toBe('');
    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('hello');

    // --- Turn 2 ---
    processEvent({ type: 'turn_start', iteration: 2 }, store);
    processEvent({ type: 'text_delta', delta: 'world' }, store);
    processEvent({ type: 'text', content: 'world' }, store);
    processEvent({ type: 'done', usage: { inputTokens: 60, outputTokens: 30 } }, store);

    // Verify accumulated state
    const state = store.getState();
    expect(state.status).toBe('idle');
    expect(state.messages.turns.length).toBe(2);
    expect(state.messages.turns[0].content).toBe('hello');
    expect(state.messages.turns[1].content).toBe('world');
    expect(state.messages.currentText).toBe('');
    // Token usage accumulates across turns
    expect(state.tokenUsage).toEqual({ inputTokens: 110, outputTokens: 50 });

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. Ctrl+C state machine transitions
// ---------------------------------------------------------------------------

describe('3. Ctrl+C state machine transitions', () => {
  test('idle -> running -> interrupting -> idle via setInterrupting + done', async () => {
    const store = new TuiStore();

    // Start from idle
    expect(store.getState().status).toBe('idle');

    // turn_start transitions to running
    processEvent({ type: 'turn_start', iteration: 1 }, store);
    expect(store.getState().status).toBe('running');

    // User hits Ctrl+C -> setInterrupting
    store.setInterrupting();
    expect(store.getState().status).toBe('interrupting');

    // Simulate abort completing: done event transitions back to idle
    processEvent({ type: 'done' }, store);
    expect(store.getState().status).toBe('idle');

    store.dispose();
  });

  test('interrupting preserves current text until done flushes it', async () => {
    const store = new TuiStore();

    processEvent({ type: 'turn_start', iteration: 1 }, store);
    processEvent({ type: 'text_delta', delta: 'Partial work...' }, store);
    expect(store.getState().messages.currentText).toBe('Partial work...');

    store.setInterrupting();
    expect(store.getState().status).toBe('interrupting');
    // currentText is preserved during interrupting state
    expect(store.getState().messages.currentText).toBe('Partial work...');

    // done flushes currentText into turns
    processEvent({ type: 'done' }, store);
    expect(store.getState().status).toBe('idle');
    expect(store.getState().messages.currentText).toBe('');
    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('Partial work...');

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// 4. Renderer extension invocation
// ---------------------------------------------------------------------------

describe('4. Renderer extension invocation', () => {
  test('renderer receives events matching its eventType', async () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();
    const calls: AgentEvent[] = [];

    await registry.registerPlugin(createRecorderPlugin('test-renderer', 'text_delta', calls));

    const event: AgentEvent = { type: 'text_delta', delta: 'Hello' };
    processEvent(event, store, registry);

    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(event);
    // Store state is still updated correctly
    expect(store.getState().messages.currentText).toBe('Hello');

    store.dispose();
  });

  test('renderer that throws does not prevent store update (error isolation)', async () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();

    // Register a renderer that throws
    await registry.registerPlugin(createThrowingPlugin('bad-renderer', 'text_delta'));

    // processEvent should not throw
    expect(() =>
      processEvent({ type: 'text_delta', delta: 'Still works' }, store, registry),
    ).not.toThrow();

    // Store state must still be updated despite renderer error
    expect(store.getState().messages.currentText).toBe('Still works');

    store.dispose();
  });

  test('multiple renderers for same eventType all get invoked', async () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();
    const calls1: AgentEvent[] = [];
    const calls2: AgentEvent[] = [];

    await registry.registerPlugin(createRecorderPlugin('r1', 'text_delta', calls1));
    await registry.registerPlugin(createRecorderPlugin('r2', 'text_delta', calls2));

    const event: AgentEvent = { type: 'text_delta', delta: 'test' };
    processEvent(event, store, registry);

    expect(calls1.length).toBe(1);
    expect(calls2.length).toBe(1);
    expect(calls1[0]).toBe(event);
    expect(calls2[0]).toBe(event);

    store.dispose();
  });

  test('renderer for different eventType is not invoked', async () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();
    const calls: AgentEvent[] = [];

    await registry.registerPlugin(createRecorderPlugin('tool-renderer', 'tool_use', calls));

    processEvent({ type: 'text_delta', delta: 'Hello' }, store, registry);

    expect(calls.length).toBe(0);
    // But store is still updated
    expect(store.getState().messages.currentText).toBe('Hello');

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// 5. Tool call lifecycle
// ---------------------------------------------------------------------------

describe('5. Tool call lifecycle', () => {
  test('turn_start -> tool_use -> tool_result -> turn_end -> done completes tool flow', async () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();

    // 1. Start turn
    processEvent({ type: 'turn_start', iteration: 1 }, store, registry);
    expect(store.getState().status).toBe('running');
    expect(store.getState().toolCalls.size).toBe(0);

    // 2. Tool use appears
    processEvent(
      {
        type: 'tool_use',
        toolCall: {
          type: 'tool-call',
          toolCallId: 'tc_1',
          toolName: 'read_file',
          input: { path: '/tmp/test.txt' },
        },
      },
      store,
      registry,
    );
    expect(store.getState().toolCalls.size).toBe(1);
    const toolEntry = store.getState().toolCalls.get('tc_1');
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.toolName).toBe('read_file');
    expect(toolEntry!.input).toEqual({ path: '/tmp/test.txt' });
    expect(toolEntry!.status).toBe('pending');

    // 3. Tool result arrives
    processEvent(
      {
        type: 'tool_result',
        toolCallId: 'tc_1',
        result: 'file contents here',
        isError: false,
      },
      store,
      registry,
    );
    const completedTool = store.getState().toolCalls.get('tc_1');
    expect(completedTool!.status).toBe('complete');
    expect(completedTool!.result).toBe('file contents here');
    expect(completedTool!.isError).toBe(false);

    // 4. Turn end (no state change, but verify no crash)
    processEvent(
      { type: 'turn_end', iteration: 1, toolCallCount: 1 },
      store,
      registry,
    );

    // 5. Done
    processEvent(
      { type: 'done', usage: { inputTokens: 200, outputTokens: 100 } },
      store,
      registry,
    );

    const state = store.getState();
    expect(state.status).toBe('idle');
    expect(state.tokenUsage).toEqual({ inputTokens: 200, outputTokens: 100 });
    // toolCalls is NOT reset by done; only by turn_start
    expect(state.toolCalls.get('tc_1')!.status).toBe('complete');
    // No text was streamed, so turns should be empty
    expect(state.messages.turns.length).toBe(0);
    expect(state.messages.currentText).toBe('');

    store.dispose();
  });

  test('tool with error result is tracked correctly', async () => {
    const store = new TuiStore();

    processEvent({ type: 'turn_start', iteration: 1 }, store);
    processEvent(
      {
        type: 'tool_use',
        toolCall: {
          type: 'tool-call',
          toolCallId: 'tc_err',
          toolName: 'bash',
          input: { command: 'exit 1' },
        },
      },
      store,
    );
    processEvent(
      {
        type: 'tool_result',
        toolCallId: 'tc_err',
        result: 'command failed with exit code 1',
        isError: true,
      },
      store,
    );

    const entry = store.getState().toolCalls.get('tc_err');
    expect(entry!.status).toBe('complete');
    expect(entry!.isError).toBe(true);
    expect(entry!.result).toBe('command failed with exit code 1');

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// 6. Auto-save integration with processEvent
// ---------------------------------------------------------------------------

describe('6. Auto-save integration with processEvent', () => {
  test('auto-save handler writes session file after done event', async () => {
    const store = new TuiStore();
    const sessionId = store.getState().sessionId;

    // Set up auto-save handler with temp directory
    const autoSave = createAutoSaveHandler({
      getSessionId: () => store.getState().sessionId,
      getMessages: () => store.getState().messages.turns,
      getAgentMessages: () => [],
      getModel: () => 'test-model',
      sessionsDir: tempDir,
      startTime: '2026-04-19T10:00:00Z',
    });

    // Run a full turn through processEvent
    processEvent({ type: 'turn_start', iteration: 1 }, store);
    processEvent({ type: 'text_delta', delta: 'Hello from auto-save test' }, store);
    processEvent({ type: 'text', content: 'Hello from auto-save test' }, store);
    processEvent(
      { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } },
      store,
    );

    // Verify store has the turn
    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('Hello from auto-save test');

    // Invoke auto-save (simulating what would happen in the event pipeline)
    await autoSave('done');

    // Verify session file was written to disk
    const filePath = join(tempDir, sessionFilename(sessionId));
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    expect(data.sessionId).toBe(sessionId);
    expect(data.status).toBe('completed');
    expect(data.model).toBe('test-model');
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].content).toBe('Hello from auto-save test');
    expect(data.messages[0].role).toBe('assistant');

    store.dispose();
  });

  test('auto-save handler does not write file for non-terminal events', async () => {
    const store = new TuiStore();

    const autoSave = createAutoSaveHandler({
      getSessionId: () => store.getState().sessionId,
      getMessages: () => store.getState().messages.turns,
      getAgentMessages: () => [],
      getModel: () => 'test-model',
      sessionsDir: tempDir,
      startTime: '2026-04-19T10:00:00Z',
    });

    // Invoke auto-save with non-terminal event types
    await autoSave('text_delta');
    await autoSave('turn_start');
    await autoSave('tool_use');

    // No session files should exist
    const { readdir } = await import('fs/promises');
    const files = await readdir(tempDir);
    expect(files.length).toBe(0);

    store.dispose();
  });

  test('auto-save on error event creates crashed session', async () => {
    const store = new TuiStore();
    const sessionId = store.getState().sessionId;

    const autoSave = createAutoSaveHandler({
      getSessionId: () => store.getState().sessionId,
      getMessages: () => store.getState().messages.turns,
      getAgentMessages: () => [],
      getModel: () => 'test-model',
      sessionsDir: tempDir,
      startTime: '2026-04-19T10:00:00Z',
    });

    // Simulate a turn that ends with error
    processEvent({ type: 'turn_start', iteration: 1 }, store);
    processEvent({ type: 'text_delta', delta: 'Partial response...' }, store);
    processEvent(
      { type: 'error', error: new Error('API rate limit'), code: 'rate_limited' },
      store,
    );

    // Verify store captured the partial turn
    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('Partial response...');

    // Auto-save on error
    await autoSave('error');

    const filePath = join(tempDir, sessionFilename(sessionId));
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    expect(data.sessionId).toBe(sessionId);
    expect(data.status).toBe('crashed');
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].content).toBe('Partial response...');

    store.dispose();
  });

  test('multi-turn conversation auto-saves all accumulated turns', async () => {
    const store = new TuiStore();
    const sessionId = store.getState().sessionId;

    const autoSave = createAutoSaveHandler({
      getSessionId: () => store.getState().sessionId,
      getMessages: () => store.getState().messages.turns,
      getAgentMessages: () => [],
      getModel: () => 'test-model',
      sessionsDir: tempDir,
      startTime: '2026-04-19T10:00:00Z',
    });

    // Turn 1
    processEvent({ type: 'turn_start', iteration: 1 }, store);
    processEvent({ type: 'text_delta', delta: 'First response' }, store);
    processEvent({ type: 'done', usage: { inputTokens: 50, outputTokens: 20 } }, store);

    // Turn 2
    processEvent({ type: 'turn_start', iteration: 2 }, store);
    processEvent({ type: 'text_delta', delta: 'Second response' }, store);
    processEvent({ type: 'done', usage: { inputTokens: 80, outputTokens: 40 } }, store);

    // Verify 2 turns accumulated
    expect(store.getState().messages.turns.length).toBe(2);

    // Auto-save
    await autoSave('done');

    const filePath = join(tempDir, sessionFilename(sessionId));
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    expect(data.messages.length).toBe(2);
    expect(data.messages[0].content).toBe('First response');
    expect(data.messages[1].content).toBe('Second response');

    store.dispose();
  });
});
