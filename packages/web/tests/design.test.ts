import { describe, expect, test } from 'bun:test';
import type { AgentSessionSummary, ToolCallEntry } from '@cortx/store';
import {
  compactPath,
  compactSessionId,
  formatElapsed,
  formatTokenCount,
  formatTokenUsage,
  statusTone,
  summarizeInspector,
  truncateMiddle,
} from '../src/design';
import { WorkbenchContributionRegistry } from '../src/workbench/contribution-registry';
import { resolveWorkbenchLayout } from '../src/workbench/layout';

describe('web design helpers', () => {
  test('compactPath keeps the last useful workspace segments', () => {
    expect(compactPath('/')).toBe('/');
    expect(compactPath('/repo')).toBe('repo');
    expect(compactPath('/Users/dev/work/cortx/')).toBe('work/cortx');
  });

  test('statusTone maps each store status to a readable label and busy flag', () => {
    expect(statusTone('idle')).toMatchObject({ label: 'Ready', busy: false });
    expect(statusTone('running')).toMatchObject({ label: 'Working', busy: true });
    expect(statusTone('awaiting_user')).toMatchObject({ label: 'Awaiting Input', busy: true });
    expect(statusTone('error')).toMatchObject({ label: 'Error', busy: false });
  });

  test('token and elapsed formatting stays compact', () => {
    expect(formatTokenCount(42)).toBe('42');
    expect(formatTokenCount(1200)).toBe('1.2k');
    expect(formatTokenCount(12500)).toBe('13k');
    expect(formatTokenUsage({ inputTokens: 1500, outputTokens: 80 })).toBe('1.5k in / 80 out');
    expect(formatElapsed(0.3)).toBe('0s');
    expect(formatElapsed(42)).toBe('42s');
    expect(formatElapsed(125)).toBe('2m 5s');
  });

  test('summarizeInspector counts tool and sub-agent states', () => {
    const tools = new Map<string, ToolCallEntry>([
      ['a', { toolName: 'read', input: {}, status: 'pending' }],
      ['b', { toolName: 'write', input: {}, status: 'complete' }],
      ['c', { toolName: 'bash', input: {}, status: 'complete', isError: true }],
    ]);
    const agents = new Map<string, AgentSessionSummary>([
      [
        'agent_1',
        {
          toolCallId: 'agent_1',
          description: 'Review',
          status: 'running',
          isBackground: true,
          iterations: 1,
          toolCallCount: 2,
        },
      ],
      [
        'agent_2',
        {
          toolCallId: 'agent_2',
          description: 'Fix',
          status: 'error',
          isBackground: false,
          iterations: 2,
          toolCallCount: 1,
        },
      ],
    ]);

    expect(summarizeInspector(tools, agents)).toEqual({
      totalTools: 3,
      pendingTools: 1,
      failedTools: 1,
      completedTools: 1,
      totalAgents: 2,
      runningAgents: 1,
      failedAgents: 1,
      backgroundAgents: 1,
    });
  });

  test('session and middle truncation helpers are stable', () => {
    expect(compactSessionId(undefined)).toBe('no session');
    expect(compactSessionId('sess_123456789')).toBe('sess_12345');
    expect(truncateMiddle('abcdefghijklmnopqrstuvwxyz', 12)).toBe('abcd...wxyz');
  });

  test('workbench layout preserves conversation priority across breakpoints', () => {
    expect(resolveWorkbenchLayout(1440, true)).toMatchObject({ mode: 'wide', railDocked: true, sidePaneDocked: true });
    expect(resolveWorkbenchLayout(900, true)).toMatchObject({ mode: 'drawer', railDocked: true, sidePaneDocked: false });
    expect(resolveWorkbenchLayout(390, true)).toMatchObject({ mode: 'single-pane', railDocked: false, sidePaneDocked: false });
  });

  test('contribution registration is ordered, disposable, and listener-isolated', () => {
    const registry = new WorkbenchContributionRegistry();
    registry.subscribe(() => {
      throw new Error('isolated');
    });
    const removeContext = registry.register({
      id: 'context',
      area: 'side-pane',
      label: 'Context',
      order: 20,
      content: { kind: 'context' },
    });
    registry.register({
      id: 'activity',
      area: 'side-pane',
      label: 'Activity',
      order: 10,
      content: { kind: 'activity' },
    });
    expect(registry.getSnapshot().map((entry) => entry.id)).toEqual(['activity', 'context']);
    removeContext();
    expect(registry.getSnapshot().map((entry) => entry.id)).toEqual(['activity']);
  });
});
