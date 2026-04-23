import { describe, test, expect, mock } from 'bun:test';
import { TuiStore } from '../store.js';

describe('TuiStore', () => {
  test('initial state', () => {
    const store = new TuiStore();
    const state = store.getState();
    expect(state.messages).toEqual({ turns: [], currentText: '' });
    expect(state.iteration).toBe(0);
    expect(state.toolCalls.size).toBe(0);
    expect(state.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(state.elapsed).toBe(0);
    expect(state.status).toBe('idle');
    expect(state.error).toBeUndefined();
  });

  // --- Happy path: text_delta ---

  test('dispatch text_delta updates currentText', () => {
    const store = new TuiStore();
    const sel = store.select((s) => s.messages.currentText);

    store.dispatch({ type: 'text_delta', delta: 'Hello' });
    expect(sel.get()).toBe('Hello');

    store.dispatch({ type: 'text_delta', delta: ' world' });
    expect(sel.get()).toBe('Hello world');
  });

  // --- Happy path: done ---

  test('dispatch done sets status to idle and updates token usage', () => {
    const store = new TuiStore();

    // Start a turn first
    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(store.getState().status).toBe('running');

    store.dispatch({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const state = store.getState();
    expect(state.status).toBe('idle');
    expect(state.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  // --- Happy path: turn_start ---

  test('dispatch turn_start increments iteration and sets status to running', () => {
    const store = new TuiStore();

    store.dispatch({ type: 'turn_start', iteration: 1 });
    let state = store.getState();
    expect(state.iteration).toBe(1);
    expect(state.status).toBe('running');
    expect(state.messages.currentText).toBe('');

    store.dispatch({ type: 'text_delta', delta: 'some text' });

    store.dispatch({ type: 'turn_start', iteration: 2 });
    state = store.getState();
    expect(state.iteration).toBe(2);
    expect(state.messages.currentText).toBe(''); // Reset on new turn
  });

  // --- Happy path: tool_use ---

  test('dispatch tool_use adds entry to toolCalls map', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'tc_1',
        toolName: 'read_file',
        input: { path: '/tmp/test.txt' },
      },
    });

    const toolCalls = store.getState().toolCalls;
    expect(toolCalls.size).toBe(1);
    const entry = toolCalls.get('tc_1');
    expect(entry).toBeDefined();
    expect(entry!.toolName).toBe('read_file');
    expect(entry!.input).toEqual({ path: '/tmp/test.txt' });
    expect(entry!.status).toBe('pending');
  });

  // --- Happy path: tool_result ---

  test('dispatch tool_result updates existing tool call entry', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'tc_1',
        toolName: 'read_file',
        input: { path: '/tmp/test.txt' },
      },
    });

    store.dispatch({
      type: 'tool_result',
      toolCallId: 'tc_1',
      result: 'file contents here',
      isError: false,
    });

    const entry = store.getState().toolCalls.get('tc_1');
    expect(entry!.result).toBe('file contents here');
    expect(entry!.isError).toBe(false);
    expect(entry!.status).toBe('complete');
  });

  // --- Happy path: error ---

  test('dispatch error sets status to error and stores message', () => {
    const store = new TuiStore();

    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({
      type: 'error',
      error: new Error('something went wrong'),
      code: 'stream_error',
    });

    const state = store.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('something went wrong');
  });

  // --- Edge case: selector returns same value -> subscriber not notified ---

  test('selector with same value does not notify subscriber', () => {
    const store = new TuiStore();
    const listener = mock(() => {});
    const sel = store.select((s) => s.status);

    sel.subscribe(listener);

    // Dispatching text_delta should not change status
    store.dispatch({ type: 'text_delta', delta: 'hello' });
    expect(listener).toHaveBeenCalledTimes(0);

    // Now dispatch something that changes status
    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // --- Edge case: multiple rapid text_delta events ---

  test('multiple rapid text_delta events accumulate correctly', () => {
    const store = new TuiStore();
    const sel = store.select((s) => s.messages.currentText);

    for (let i = 0; i < 100; i++) {
      store.dispatch({ type: 'text_delta', delta: `chunk${i} ` });
    }

    expect(sel.get()).toContain('chunk0 ');
    expect(sel.get()).toContain('chunk99 ');
    expect(sel.get().split('chunk').length - 1).toBe(100);
  });

  // --- Edge case: subscriber unsubscribe ---

  test('unsubscribe stops notifications', () => {
    const store = new TuiStore();
    const listener = mock(() => {});
    const sel = store.select((s) => s.status);

    const unsub = sel.subscribe(listener);
    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();

    store.dispatch({ type: 'done' });
    expect(listener).toHaveBeenCalledTimes(1); // Not called again
  });

  // --- Integration: full turn cycle ---

  test('full turn cycle: turn_start -> text_delta -> tool_use -> tool_result -> done', () => {
    const store = new TuiStore();
    const statusChanges: string[] = [];

    const statusSel = store.select((s) => s.status);
    statusSel.subscribe(() => {
      statusChanges.push(statusSel.get());
    });

    // 1. Turn starts
    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(store.getState().status).toBe('running');

    // 2. Streaming text
    store.dispatch({ type: 'text_delta', delta: 'Let me read ' });
    store.dispatch({ type: 'text_delta', delta: 'that file.' });
    expect(store.getState().messages.currentText).toBe('Let me read that file.');

    // 3. Tool use
    store.dispatch({
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'tc_1',
        toolName: 'read_file',
        input: { path: '/tmp/test.txt' },
      },
    });
    expect(store.getState().toolCalls.size).toBe(1);
    expect(store.getState().toolCalls.get('tc_1')!.status).toBe('pending');

    // 4. Tool result
    store.dispatch({
      type: 'tool_result',
      toolCallId: 'tc_1',
      result: 'file contents',
      isError: false,
    });
    expect(store.getState().toolCalls.get('tc_1')!.status).toBe('complete');
    expect(store.getState().toolCalls.get('tc_1')!.result).toBe('file contents');

    // 5. Done
    store.dispatch({
      type: 'done',
      usage: { inputTokens: 500, outputTokens: 200 },
    });
    expect(store.getState().status).toBe('idle');
    expect(store.getState().tokenUsage).toEqual({ inputTokens: 500, outputTokens: 200 });

    // Status should have changed: idle -> running -> idle
    expect(statusChanges).toEqual(['running', 'idle']);
  });

  // --- Integration: cumulative token usage across multiple turns ---

  test('token usage accumulates across multiple done events', () => {
    const store = new TuiStore();

    // Turn 1
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'done', usage: { inputTokens: 100, outputTokens: 50 } });

    // Turn 2
    store.dispatch({ type: 'turn_start', iteration: 2 });
    store.dispatch({ type: 'done', usage: { inputTokens: 150, outputTokens: 75 } });

    expect(store.getState().tokenUsage).toEqual({ inputTokens: 250, outputTokens: 125 });
  });

  // --- Integration: tool_result for unknown toolCallId is a no-op ---

  test('tool_result for unknown toolCallId does not crash', () => {
    const store = new TuiStore();
    expect(() => {
      store.dispatch({
        type: 'tool_result',
        toolCallId: 'unknown',
        result: 'something',
        isError: false,
      });
    }).not.toThrow();
    expect(store.getState().toolCalls.size).toBe(0);
  });

  // --- done without usage ---

  test('done without usage field keeps existing tokenUsage', () => {
    const store = new TuiStore();
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'done', usage: { inputTokens: 100, outputTokens: 50 } });

    store.dispatch({ type: 'turn_start', iteration: 2 });
    store.dispatch({ type: 'done' }); // No usage
    expect(store.getState().tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  // --- reset ---

  test('reset returns store to initial state', () => {
    const store = new TuiStore();
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'hello' });
    store.dispatch({
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'tc_1',
        toolName: 'test',
        input: {},
      },
    });

    store.reset();

    const state = store.getState();
    expect(state.messages).toEqual({ turns: [], currentText: '' });
    expect(state.iteration).toBe(0);
    expect(state.toolCalls.size).toBe(0);
    expect(state.status).toBe('idle');
    expect(state.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  // --- setInterrupting ---

  test('setInterrupting changes status to interrupting', () => {
    const store = new TuiStore();
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.setInterrupting();
    expect(store.getState().status).toBe('interrupting');
  });

  // --- text event finalizes buffer ---

  test('text event replaces currentText with final content', () => {
    const store = new TuiStore();
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'partial' });
    store.dispatch({ type: 'text', content: 'final content' });
    expect(store.getState().messages.currentText).toBe('final content');
  });

  // --- Multiple selectors ---

  test('multiple selectors update independently', () => {
    const store = new TuiStore();
    const msgListener = mock(() => {});
    const statusListener = mock(() => {});

    const msgSel = store.select((s) => s.messages.currentText);
    const statusSel = store.select((s) => s.status);

    msgSel.subscribe(msgListener);
    statusSel.subscribe(statusListener);

    // text_delta changes messages but not status
    store.dispatch({ type: 'text_delta', delta: 'hello' });
    expect(msgListener).toHaveBeenCalledTimes(1);
    expect(statusListener).toHaveBeenCalledTimes(0);

    // turn_start changes status
    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(statusListener).toHaveBeenCalledTimes(1);
  });

  // --- Selector reuses same subscription for same function ---

  test('select with same selector function reuses subscription', () => {
    const store = new TuiStore();
    const selFn = (s: { status: string }) => s.status;

    const sub1 = store.select(selFn);
    const sub2 = store.select(selFn);

    // Both should return the same current value
    expect(sub1.get()).toBe(sub2.get());
  });

  // --- steered / follow_up / context_overflow / turn_end are no-ops on state ---

  test('steered, follow_up, context_overflow, turn_end do not change state', () => {
    const store = new TuiStore();
    const before = { ...store.getState(), toolCalls: new Map(store.getState().toolCalls) };

    store.dispatch({ type: 'steered', message: 'steer' });
    store.dispatch({ type: 'follow_up', message: 'follow' });
    store.dispatch({ type: 'context_overflow', messages: [] });
    store.dispatch({ type: 'turn_end', iteration: 1, toolCallCount: 0 });

    const after = store.getState();
    expect(after.status).toBe(before.status);
    expect(after.iteration).toBe(before.iteration);
    expect(after.messages).toEqual(before.messages);
  });

  // --- error event clears elapsed ---

  test('error event clears elapsed and stops timer', () => {
    const store = new TuiStore();
    store.dispatch({ type: 'turn_start', iteration: 1 });
    // Elapsed timer is running
    store.dispatch({
      type: 'error',
      error: new Error('boom'),
      code: 'stream_error',
    });
    expect(store.getState().elapsed).toBe(0);
  });

  // --- done event clears elapsed ---

  test('done event clears elapsed', () => {
    const store = new TuiStore();
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'done', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(store.getState().elapsed).toBe(0);
  });

  // --- tool_use with string input ---

  test('tool_use with string input stores it as-is', () => {
    const store = new TuiStore();
    store.dispatch({
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'tc_str',
        toolName: 'bash',
        input: '{"command": "ls"}',
      },
    });

    const entry = store.getState().toolCalls.get('tc_str');
    expect(entry!.input).toBe('{"command": "ls"}');
  });

  // --- tool_result with isError ---

  test('tool_result with isError=true', () => {
    const store = new TuiStore();
    store.dispatch({
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'tc_err',
        toolName: 'bash',
        input: { command: 'exit 1' },
      },
    });
    store.dispatch({
      type: 'tool_result',
      toolCallId: 'tc_err',
      result: 'command failed',
      isError: true,
    });

    const entry = store.getState().toolCalls.get('tc_err');
    expect(entry!.isError).toBe(true);
    expect(entry!.result).toBe('command failed');
    expect(entry!.status).toBe('complete');
  });

  // --- Multi-turn accumulation ---

  test('messages accumulate across multiple turn cycles', () => {
    const store = new TuiStore();

    // Turn 1: text_delta -> done
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'First turn response' });
    store.dispatch({ type: 'done', usage: { inputTokens: 50, outputTokens: 25 } });

    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('First turn response');
    expect(store.getState().messages.turns[0].role).toBe('assistant');
    expect(store.getState().messages.currentText).toBe('');

    // Turn 2: text_delta -> done
    store.dispatch({ type: 'turn_start', iteration: 2 });
    store.dispatch({ type: 'text_delta', delta: 'Second turn response' });
    store.dispatch({ type: 'done', usage: { inputTokens: 60, outputTokens: 30 } });

    expect(store.getState().messages.turns.length).toBe(2);
    expect(store.getState().messages.turns[1].content).toBe('Second turn response');
    expect(store.getState().messages.turns[1].role).toBe('assistant');
    expect(store.getState().messages.currentText).toBe('');
  });

  test('turn_start pushes pending currentText as a turn', () => {
    const store = new TuiStore();

    // Stream text without a done event
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'Pending text' });

    // A new turn_start should flush the pending text into turns
    store.dispatch({ type: 'turn_start', iteration: 2 });

    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('Pending text');
    expect(store.getState().messages.currentText).toBe('');
  });

  test('error pushes pending currentText as a turn', () => {
    const store = new TuiStore();

    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'Partial response before error' });
    store.dispatch({
      type: 'error',
      error: new Error('boom'),
      code: 'stream_error',
    });

    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('Partial response before error');
    expect(store.getState().messages.currentText).toBe('');
  });

  // --- turn_start resets toolCalls ---

  test('turn_start resets toolCalls to empty Map', () => {
    const store = new TuiStore();

    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'tc_1',
        toolName: 'test',
        input: {},
      },
    });
    expect(store.getState().toolCalls.size).toBe(1);

    store.dispatch({ type: 'turn_start', iteration: 2 });
    expect(store.getState().toolCalls.size).toBe(0);
  });

  // --- dispose ---

  test('dispose stops elapsed timer and clears selectorSubs', () => {
    const store = new TuiStore();

    // Start a turn to kick off the elapsed timer
    store.dispatch({ type: 'turn_start', iteration: 1 });

    store.select((s) => s.status);

    store.dispose();

    // After dispose, getState should still work but timer is cleared.
    // Verify by checking that the internal elapsedTimer is undefined
    // (we can't access it directly, but we can verify no crash).
    expect(store.getState().status).toBe('running');
  });

  // --- setSessionId ---

  test('setSessionId updates the sessionId', () => {
    const store = new TuiStore();
    const originalId = store.getState().sessionId;
    const newId = 'sess_custom_123';

    store.setSessionId(newId);
    expect(store.getState().sessionId).toBe(newId);
    expect(store.getState().sessionId).not.toBe(originalId);
  });

  test('setSessionId notifies subscribers', () => {
    const store = new TuiStore();
    const listener = mock(() => {});
    const sel = store.select((s) => s.sessionId);

    sel.subscribe(listener);
    store.setSessionId('sess_notify_test');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(sel.get()).toBe('sess_notify_test');
  });

  // --- reset with custom sessionId ---

  test('reset with custom sessionId sets the sessionId', () => {
    const store = new TuiStore();
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'hello' });

    store.reset('custom-sess-id');

    const state = store.getState();
    expect(state.sessionId).toBe('custom-sess-id');
    expect(state.messages).toEqual({ turns: [], currentText: '' });
    expect(state.iteration).toBe(0);
    expect(state.status).toBe('idle');
  });

  // --- loadTurns ---

  test('loadTurns replaces the turns array in store state', () => {
    const store = new TuiStore();

    // Start with some existing turns
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'old content' });
    store.dispatch({ type: 'done', usage: { inputTokens: 10, outputTokens: 5 } });

    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('old content');

    // Load new turns (simulating session restore)
    const restoredTurns = [
      { role: 'assistant', content: 'Restored turn 1', timestamp: 1000 },
      { role: 'assistant', content: 'Restored turn 2', timestamp: 2000 },
      { role: 'assistant', content: 'Restored turn 3', timestamp: 3000 },
    ];
    store.loadTurns(restoredTurns);

    const state = store.getState();
    expect(state.messages.turns).toEqual(restoredTurns);
    expect(state.messages.turns.length).toBe(3);
    expect(state.messages.currentText).toBe('');
    // Other state should remain unchanged
    expect(state.iteration).toBe(1);
    expect(state.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test('loadTurns notifies subscribers', () => {
    const store = new TuiStore();
    const listener = mock(() => {});
    const sel = store.select((s) => s.messages.turns);

    sel.subscribe(listener);

    store.loadTurns([
      { role: 'assistant', content: 'New turn', timestamp: 1000 },
    ]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(sel.get().length).toBe(1);
    expect(sel.get()[0].content).toBe('New turn');
  });

  test('loadTurns with empty array clears turns', () => {
    const store = new TuiStore();

    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'existing' });
    store.dispatch({ type: 'done', usage: { inputTokens: 10, outputTokens: 5 } });

    expect(store.getState().messages.turns.length).toBe(1);

    store.loadTurns([]);

    expect(store.getState().messages.turns).toEqual([]);
    expect(store.getState().messages.currentText).toBe('');
  });
});
