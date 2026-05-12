import { describe, test, expect } from 'bun:test';
import { serializeAgentState, deserializeAgentState } from '../src/serialization';
import type { AgentState, ToolCallEntry, AgentSessionSummary } from '../src/types';

function makeTestState(overrides?: Partial<AgentState>): AgentState {
  return {
    sessionId: 'sess_test_123',
    messages: { turns: [], currentText: '', currentThinking: '' },
    iteration: 0,
    toolCalls: new Map(),
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    totalElapsed: 0,
    elapsed: 0,
    status: 'idle',
    error: undefined,
    agentSessions: new Map(),
    ...overrides,
  };
}

describe('serialization', () => {
  test('round-trip with empty state', () => {
    const state = makeTestState();
    const serialized = serializeAgentState(state);
    const restored = deserializeAgentState(serialized);

    expect(restored.sessionId).toBe(state.sessionId);
    expect(restored.messages).toEqual(state.messages);
    expect(restored.iteration).toBe(state.iteration);
    expect(restored.toolCalls.size).toBe(0);
    expect(restored.agentSessions.size).toBe(0);
    expect(restored.status).toBe('idle');
    expect(restored.error).toBeUndefined();
  });

  test('round-trip preserves tool calls with Map entries', () => {
    const toolCalls = new Map<string, ToolCallEntry>();
    toolCalls.set('tc_1', {
      toolName: 'bash',
      input: { command: 'echo hello' },
      result: 'hello\n',
      status: 'complete',
      isError: false,
    });
    toolCalls.set('tc_2', {
      toolName: 'read',
      input: { file_path: '/src/index.ts' },
      status: 'pending',
    });

    const state = makeTestState({ toolCalls });
    const serialized = serializeAgentState(state);
    const restored = deserializeAgentState(serialized);

    expect(restored.toolCalls.size).toBe(2);
    expect(restored.toolCalls.get('tc_1')).toEqual({
      toolName: 'bash',
      input: { command: 'echo hello' },
      result: 'hello\n',
      status: 'complete',
      isError: false,
    });
    expect(restored.toolCalls.get('tc_2')).toEqual({
      toolName: 'read',
      input: { file_path: '/src/index.ts' },
      status: 'pending',
    });
  });

  test('round-trip preserves agent sessions with Map entries', () => {
    const agentSessions = new Map<string, AgentSessionSummary>();
    agentSessions.set('tc_1', {
      toolCallId: 'tc_1',
      description: 'Research task',
      status: 'completed',
      isBackground: false,
      iterations: 3,
      toolCallCount: 5,
    });
    agentSessions.set('tc_2', {
      toolCallId: 'tc_2',
      description: 'Background agent',
      status: 'running',
      isBackground: true,
      iterations: 1,
      toolCallCount: 2,
      progress: 'working...',
    });

    const state = makeTestState({ agentSessions });
    const serialized = serializeAgentState(state);
    const restored = deserializeAgentState(serialized);

    expect(restored.agentSessions.size).toBe(2);
    expect(restored.agentSessions.get('tc_1')).toEqual(agentSessions.get('tc_1'));
    expect(restored.agentSessions.get('tc_2')).toEqual(agentSessions.get('tc_2'));
  });

  test('round-trip preserves messages and token usage', () => {
    const state = makeTestState({
      messages: {
        turns: [
          { role: 'user', content: 'Hello', timestamp: 1000 },
          { role: 'assistant', content: 'Hi there', timestamp: 2000, duration: 1.5 },
        ],
        currentText: 'streaming...',
        currentThinking: 'hmm',
      },
      iteration: 3,
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      totalElapsed: 12,
      elapsed: 5,
      status: 'running',
      error: undefined,
    });

    const restored = deserializeAgentState(serializeAgentState(state));
    expect(restored.messages).toEqual(state.messages);
    expect(restored.iteration).toBe(3);
    expect(restored.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(restored.totalElapsed).toBe(12);
    expect(restored.elapsed).toBe(5);
    expect(restored.status).toBe('running');
  });

  test('round-trip preserves error state', () => {
    const state = makeTestState({ status: 'error', error: 'Something broke' });
    const restored = deserializeAgentState(serializeAgentState(state));
    expect(restored.status).toBe('error');
    expect(restored.error).toBe('Something broke');
  });

  test('handles tool call with non-JSON-serializable input', () => {
    const toolCalls = new Map<string, ToolCallEntry>();
    toolCalls.set('tc_fn', {
      toolName: 'test',
      input: () => 'I am a function',
      status: 'pending' as const,
    });

    const state = makeTestState({ toolCalls });
    const serialized = serializeAgentState(state);

    // Function should be stringified
    expect(typeof serialized.toolCalls['tc_fn'].input).toBe('string');

    const restored = deserializeAgentState(serialized);
    expect(restored.toolCalls.get('tc_fn')!.toolName).toBe('test');
    // Input comes back as string (can't parse a function)
    expect(typeof restored.toolCalls.get('tc_fn')!.input).toBe('string');
  });

  test('handles tool call with undefined result', () => {
    const toolCalls = new Map<string, ToolCallEntry>();
    toolCalls.set('tc_1', {
      toolName: 'test',
      input: 'data',
      status: 'pending',
    });

    const state = makeTestState({ toolCalls });
    const serialized = serializeAgentState(state);
    expect(serialized.toolCalls['tc_1'].result).toBeUndefined();

    const restored = deserializeAgentState(serialized);
    expect(restored.toolCalls.get('tc_1')!.result).toBeUndefined();
  });

  test('serialized form has no Map instances', () => {
    const state = makeTestState({
      toolCalls: new Map([['tc_1', { toolName: 'bash', input: {}, status: 'pending' as const }]]),
      agentSessions: new Map([['tc_1', { toolCallId: 'tc_1', description: 'test', status: 'running' as const, isBackground: false, iterations: 0, toolCallCount: 0 }]]),
    });

    const serialized = serializeAgentState(state);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);

    expect(parsed.toolCalls).toEqual({ tc_1: expect.any(Object) });
    expect(parsed.agentSessions).toEqual({ tc_1: expect.any(Object) });
    expect(parsed.toolCalls).not.toBeInstanceOf(Map);
    expect(parsed.agentSessions).not.toBeInstanceOf(Map);
  });
});
