import { describe, expect, test } from 'bun:test';
import { adjacentAgentSessionId, agentSessionIds } from '../components/agent-viewer.js';
import { firstViewableAgentToolCallId, formatToolStats, toolStats, visibleToolEntries } from '../components/tool-region.js';
import type { AgentSessionSummary, ToolCallEntry } from '../types/tui-state.js';

function session(id: string, status: AgentSessionSummary['status']): AgentSessionSummary {
  return {
    toolCallId: id,
    description: id,
    status,
    isBackground: false,
    iterations: 0,
    toolCallCount: 0,
  };
}

describe('agent viewer navigation helpers', () => {
  test('orders running and error agents before completed sessions', () => {
    const sessions = new Map<string, AgentSessionSummary>([
      ['done', session('done', 'completed')],
      ['running', session('running', 'running')],
      ['error', session('error', 'error')],
    ]);

    expect(agentSessionIds(sessions)).toEqual(['running', 'error', 'done']);
  });

  test('wraps adjacent agent navigation', () => {
    const ids = ['a', 'b', 'c'];

    expect(adjacentAgentSessionId(ids, 'a', 'previous')).toBe('c');
    expect(adjacentAgentSessionId(ids, 'c', 'next')).toBe('a');
    expect(adjacentAgentSessionId(ids, 'b', 'next')).toBe('c');
  });

  test('selects the first agent tool with session data regardless of completion status', () => {
    const toolCalls = new Map<string, ToolCallEntry>([
      ['read_1', { toolName: 'read', input: {}, status: 'complete' }],
      ['agent_1', { toolName: 'agent', input: {}, status: 'pending' }],
      ['agent_2', { toolName: 'agent', input: {}, status: 'complete' }],
    ]);
    const sessions = new Map<string, AgentSessionSummary>([
      ['agent_1', session('agent_1', 'running')],
      ['agent_2', session('agent_2', 'completed')],
    ]);

    expect(firstViewableAgentToolCallId(toolCalls, sessions)).toBe('agent_1');
  });

  test('counts running, failed, and completed tools', () => {
    const toolCalls = new Map<string, ToolCallEntry>([
      ['read_1', { toolName: 'read', input: {}, status: 'complete' }],
      ['bash_1', { toolName: 'bash', input: {}, status: 'pending' }],
      ['edit_1', { toolName: 'edit', input: {}, status: 'complete', isError: true }],
    ]);

    const stats = toolStats(toolCalls);

    expect(stats).toEqual({ total: 3, running: 1, failed: 1, completed: 1 });
    expect(formatToolStats(stats)).toBe('1 running, 1 failed, 1 done');
  });

  test('keeps recent tool entries for expanded view', () => {
    expect(visibleToolEntries(['a', 'b', 'c', 'd'], 2)).toEqual({
      entries: ['c', 'd'],
      hiddenCount: 2,
    });
  });
});
