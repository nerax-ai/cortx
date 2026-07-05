import { describe, test, expect } from 'bun:test';
import { AgentStore } from '../src/store';
import type { AgentState } from '../src/types';
import type { AgentEvent } from '@cortx/sdk';

describe('AgentStore', () => {
  test('initial state is idle with empty fields', () => {
    const store = new AgentStore();
    const state = store.getState();
    expect(state.status).toBe('idle');
    expect(state.messages.turns).toEqual([]);
    expect(state.messages.currentText).toBe('');
    expect(state.messages.currentThinking).toBe('');
    expect(state.iteration).toBe(0);
    expect(state.toolCalls.size).toBe(0);
    expect(state.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(state.agentSessions.size).toBe(0);
    expect(state.error).toBeUndefined();
    expect(state.sessionId).toMatch(/^sess_/);
  });

  test('dispatch turn_start sets running and increments iteration', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(store.getState().status).toBe('running');
    expect(store.getState().iteration).toBe(1);
  });

  test('dispatch text_delta appends to currentText', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'text_delta', delta: 'Hello' });
    store.dispatch({ type: 'text_delta', delta: ' world' });
    expect(store.getState().messages.currentText).toBe('Hello world');
  });

  test('dispatch thinking_delta appends to currentThinking', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'thinking_delta', delta: 'Let me think' });
    expect(store.getState().messages.currentThinking).toBe('Let me think');
  });

  test('dispatch text sets currentText directly', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'text_delta', delta: 'partial' });
    store.dispatch({ type: 'text', content: 'final text' });
    expect(store.getState().messages.currentText).toBe('final text');
  });

  test('dispatch thinking sets currentThinking directly', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'thinking', content: 'deep thought' });
    expect(store.getState().messages.currentThinking).toBe('deep thought');
  });

  test('dispatch tool_use adds tool call as pending', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'tc_1', toolName: 'bash', input: '{"command":"ls"}' } });
    const tc = store.getState().toolCalls.get('tc_1');
    expect(tc).toBeDefined();
    expect(tc!.toolName).toBe('bash');
    expect(tc!.status).toBe('pending');
    expect(tc!.input).toBe('{"command":"ls"}');
  });

  test('dispatch tool_use snapshots currentText into turns', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'text_delta', delta: 'Some text' });
    store.dispatch({ type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'tc_1', toolName: 'bash', input: '{}' } });
    expect(store.getState().messages.turns).toHaveLength(1);
    expect(store.getState().messages.turns[0].role).toBe('assistant');
    expect(store.getState().messages.turns[0].content).toBe('Some text');
    expect(store.getState().messages.currentText).toBe('');
  });

  test('dispatch tool_progress updates progress text', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'tc_1', toolName: 'bash', input: '{}' } });
    store.dispatch({ type: 'tool_progress', toolCallId: 'tc_1', text: 'Running...' });
    expect(store.getState().toolCalls.get('tc_1')!.progress).toBe('Running...');
  });

  test('dispatch tool_result marks tool as complete', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'tc_1', toolName: 'bash', input: '{}' } });
    store.dispatch({ type: 'tool_result', toolCallId: 'tc_1', result: 'output', isError: false });
    const tc = store.getState().toolCalls.get('tc_1');
    expect(tc!.status).toBe('complete');
    expect(tc!.result).toBe('output');
    expect(tc!.isError).toBe(false);
  });

  test('dispatch tool_result with error', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'tc_1', toolName: 'bash', input: '{}' } });
    store.dispatch({ type: 'tool_result', toolCallId: 'tc_1', result: 'Command failed', isError: true });
    const tc = store.getState().toolCalls.get('tc_1');
    expect(tc!.status).toBe('complete');
    expect(tc!.isError).toBe(true);
  });

  test('dispatch done accumulates token usage and sets idle', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'text_delta', delta: 'final text' });
    store.dispatch({ type: 'done', usage: { inputTokens: 100, outputTokens: 50 } });
    expect(store.getState().status).toBe('idle');
    expect(store.getState().tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(store.getState().messages.currentText).toBe('');
    expect(store.getState().messages.turns).toHaveLength(1);
    expect(store.getState().messages.turns[0].content).toBe('final text');
  });

  test('dispatch done accumulates token usage across multiple runs', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'done', usage: { inputTokens: 50, outputTokens: 25 } });
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'done', usage: { inputTokens: 100, outputTokens: 75 } });
    expect(store.getState().tokenUsage).toEqual({ inputTokens: 150, outputTokens: 100 });
  });

  test('dispatch error sets error status and message', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'text_delta', delta: 'partial' });
    store.dispatch({ type: 'error', error: new Error('API rate limited'), code: 'rate_limited' });
    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toBe('API rate limited');
    expect(store.getState().messages.turns).toHaveLength(1);
    expect(store.getState().messages.currentText).toBe('');
  });

  test('dispatch agent_started adds session', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'agent_started', toolCallId: 'tc_1', description: 'Research task', isBackground: false });
    const session = store.getState().agentSessions.get('tc_1');
    expect(session).toBeDefined();
    expect(session!.description).toBe('Research task');
    expect(session!.status).toBe('running');
    expect(session!.isBackground).toBe(false);
  });

  test('dispatch agent_progress updates progress', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'agent_started', toolCallId: 'tc_1', description: 'Task', isBackground: false });
    store.dispatch({ type: 'agent_progress', toolCallId: 'tc_1', text: 'Step 1 done' });
    expect(store.getState().agentSessions.get('tc_1')!.progress).toBe('Step 1 done');
  });

  test('dispatch agent_completed marks session complete', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'agent_started', toolCallId: 'tc_1', description: 'Task', isBackground: false });
    store.dispatch({ type: 'agent_completed', toolCallId: 'tc_1', output: 'Done', iterations: 3, toolCallCount: 5 });
    const session = store.getState().agentSessions.get('tc_1');
    expect(session!.status).toBe('completed');
    expect(session!.iterations).toBe(3);
    expect(session!.toolCallCount).toBe(5);
  });

  test('dispatch agent_completed with error', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'agent_started', toolCallId: 'tc_1', description: 'Task', isBackground: true });
    store.dispatch({ type: 'agent_completed', toolCallId: 'tc_1', output: '', iterations: 1, toolCallCount: 0, isError: true });
    expect(store.getState().agentSessions.get('tc_1')!.status).toBe('error');
  });

  test('dispatch unknown event types do not crash', () => {
    const store = new AgentStore();
    const stateBefore = store.getState();
    // These are handled as no-ops
    store.dispatch({ type: 'steered', message: 'test' });
    store.dispatch({ type: 'follow_up', message: 'test' });
    store.dispatch({ type: 'context_overflow', messages: [] });
    store.dispatch({ type: 'turn_end', iteration: 1, toolCallCount: 0 });
    expect(store.getState()).toEqual(stateBefore);
  });

  test('dispatch user_request preserves selectable responses for pending approvals', () => {
    const store = new AgentStore();
    store.dispatch({
      type: 'user_request',
      request: {
        requestId: 'tc_approval',
        kind: 'tool_approval',
        prompt: 'Approve write tool?',
        allowedResponses: ['yes', 'no'],
        context: { toolName: 'write', sideEffects: 'write' },
      },
    });
    store.dispatch({ type: 'user_question', toolCallId: 'tc_approval', question: 'Approve write tool?' });

    expect(store.getState().status).toBe('awaiting_user');
    expect(store.getState().pendingQuestion).toMatchObject({
      toolCallId: 'tc_approval',
      kind: 'tool_approval',
      allowedResponses: ['yes', 'no'],
      context: { toolName: 'write', sideEffects: 'write' },
    });
  });

  test('turn_start clears tool calls and streaming state', () => {
    const store = new AgentStore();
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'text' });
    store.dispatch({ type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'tc_1', toolName: 'bash', input: '{}' } });
    expect(store.getState().toolCalls.size).toBe(1);

    store.dispatch({ type: 'turn_start', iteration: 2 });
    expect(store.getState().toolCalls.size).toBe(0);
    expect(store.getState().messages.currentText).toBe('');
    expect(store.getState().messages.currentThinking).toBe('');
  });

  test('full conversation flow', () => {
    const store = new AgentStore();
    store.addUserMessage('Hello');
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'Hi! ' });
    store.dispatch({ type: 'text_delta', delta: 'How can I help?' });
    store.dispatch({ type: 'text', content: 'Hi! How can I help?' });
    store.dispatch({ type: 'tool_use', toolCall: { type: 'tool-call', toolCallId: 'tc_1', toolName: 'bash', input: '{"command":"ls"}' } });
    store.dispatch({ type: 'tool_result', toolCallId: 'tc_1', result: 'file1.ts\nfile2.ts' });
    store.dispatch({ type: 'done', usage: { inputTokens: 50, outputTokens: 25 } });

    const state = store.getState();
    expect(state.status).toBe('idle');
    expect(state.tokenUsage).toEqual({ inputTokens: 50, outputTokens: 25 });
    // User message + assistant text (snapshotted on tool_use)
    expect(state.messages.turns.length).toBeGreaterThanOrEqual(2);
  });
});

describe('AgentStore select()', () => {
  test('select returns current value', () => {
    const store = new AgentStore();
    const statusSub = store.select((s) => s.status);
    expect(statusSub.get()).toBe('idle');
  });

  test('select notifies on change', () => {
    const store = new AgentStore();
    const statusSub = store.select((s) => s.status);
    const changes: string[] = [];
    statusSub.subscribe(() => changes.push(statusSub.get()));

    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(changes).toEqual(['running']);
  });

  test('select does not notify when value unchanged', () => {
    const store = new AgentStore();
    const sessionSub = store.select((s) => s.sessionId);
    const changes: string[] = [];
    sessionSub.subscribe(() => changes.push(sessionSub.get()));

    // Dispatch event that doesn't change sessionId
    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(changes).toHaveLength(0);
  });

  test('multiple subscribers notified correctly', () => {
    const store = new AgentStore();
    const statusSub = store.select((s) => s.status);
    const log1: string[] = [];
    const log2: string[] = [];
    statusSub.subscribe(() => log1.push(statusSub.get()));
    statusSub.subscribe(() => log2.push(statusSub.get()));

    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(log1).toEqual(['running']);
    expect(log2).toEqual(['running']);
  });

  test('unsubscribe stops notifications', () => {
    const store = new AgentStore();
    const statusSub = store.select((s) => s.status);
    const changes: string[] = [];
    const unsub = statusSub.subscribe(() => changes.push(statusSub.get()));

    store.dispatch({ type: 'turn_start', iteration: 1 });
    unsub();
    store.dispatch({ type: 'done' });

    expect(changes).toEqual(['running']); // No 'idle' after unsub
  });

  test('reusing same selector function returns same subscription', () => {
    const store = new AgentStore();
    const selector = (s: AgentState) => s.status;
    const sub1 = store.select(selector);
    const sub2 = store.select(selector);
    // Same selector function should reuse the same subscription entry
    const changes: string[] = [];
    sub1.subscribe(() => changes.push('sub1'));
    sub2.subscribe(() => changes.push('sub2'));

    store.dispatch({ type: 'turn_start', iteration: 1 });
    expect(changes).toEqual(['sub1', 'sub2']);
  });
});

describe('AgentStore addUserMessage', () => {
  test('adds user turn to messages', () => {
    const store = new AgentStore();
    store.addUserMessage('Hello');
    expect(store.getState().messages.turns).toHaveLength(1);
    expect(store.getState().messages.turns[0]).toEqual({
      role: 'user',
      content: 'Hello',
      timestamp: expect.any(Number),
    });
  });
});

describe('AgentStore reset', () => {
  test('reset clears all state', () => {
    const store = new AgentStore();
    store.addUserMessage('Hello');
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'text' });
    store.dispatch({ type: 'done', usage: { inputTokens: 10, outputTokens: 5 } });

    store.reset();

    const state = store.getState();
    expect(state.status).toBe('idle');
    expect(state.messages.turns).toEqual([]);
    expect(state.messages.currentText).toBe('');
    expect(state.iteration).toBe(0);
    expect(state.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(state.toolCalls.size).toBe(0);
    expect(state.agentSessions.size).toBe(0);
    expect(state.error).toBeUndefined();
  });

  test('reset with sessionId sets the provided ID', () => {
    const store = new AgentStore();
    store.reset('my_custom_id');
    expect(store.getState().sessionId).toBe('my_custom_id');
  });
});

describe('AgentStore setSessionId', () => {
  test('updates session ID', () => {
    const store = new AgentStore();
    store.setSessionId('restored_id');
    expect(store.getState().sessionId).toBe('restored_id');
  });
});

describe('AgentStore dispose', () => {
  test('dispose clears subscriptions and stops notifications', () => {
    const store = new AgentStore();
    const statusSub = store.select((s) => s.status);
    const changes: string[] = [];
    statusSub.subscribe(() => changes.push(statusSub.get()));

    store.dispose();
    store.dispatch({ type: 'turn_start', iteration: 1 });

    // After dispose, no notifications should fire
    expect(changes).toHaveLength(0);
  });
});
