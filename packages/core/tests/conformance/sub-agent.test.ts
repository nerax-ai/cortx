import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PluginRegistry } from '@nerax-ai/plugin';
import { Cortx, type AgentEvent } from '../../src/index.js';
import { lengthToolResponse, mockLanguage, textResponse, toolResponse } from './helpers.js';

describe('conformance: sub-agent', () => {
  beforeEach(() => {
    PluginRegistry.reset();
  });

  afterEach(() => {
    PluginRegistry.reset();
  });

  test('foreground agent tool returns child output and emits lifecycle events', async () => {
    const lifecycleEvents: AgentEvent[] = [];
    const cortx = new Cortx(mockLanguage([
      toolResponse('agent-call', 'agent', '{"prompt":"work in a child agent","description":"child task"}'),
      textResponse('child output'),
      textResponse('parent done'),
    ]), {
      model: 'test',
      workingDirectory: process.cwd(),
      askUser: async () => 'yes',
    });
    cortx.onAgentEvent = (event) => lifecycleEvents.push(event);

    const events: AgentEvent[] = [];
    for await (const event of cortx.run('delegate')) {
      events.push(event);
    }

    expect(events.find((event) => event.type === 'tool_use')).toMatchObject({
      type: 'tool_use',
      toolCall: { toolCallId: 'agent-call', toolName: 'agent' },
    });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      toolCallId: 'agent-call',
      isError: false,
    });
    expect(String(events.find((event) => event.type === 'tool_result')?.result)).toContain('child output');
    expect(lifecycleEvents.find((event) => event.type === 'agent_started')).toMatchObject({
      type: 'agent_started',
      toolCallId: 'agent-call',
      description: 'child task',
      isBackground: false,
    });
    expect(lifecycleEvents.find((event) => event.type === 'agent_completed')).toMatchObject({
      type: 'agent_completed',
      toolCallId: 'agent-call',
      output: 'child output',
      iterations: 1,
      toolCallCount: 0,
    });
    expect(events.at(-1)?.type).toBe('done');
  });

  test('foreground agent tool still runs when the provider finishes with length after complete tool input', async () => {
    const lifecycleEvents: AgentEvent[] = [];
    const cortx = new Cortx(mockLanguage([
      lengthToolResponse([
        { id: 'agent-call', name: 'agent', input: '{"prompt":"work in a child agent","description":"child task"}' },
      ]),
      textResponse('child output'),
      textResponse('parent done'),
    ]), {
      model: 'test',
      workingDirectory: process.cwd(),
      askUser: async () => 'yes',
    });
    cortx.onAgentEvent = (event) => lifecycleEvents.push(event);

    const events: AgentEvent[] = [];
    for await (const event of cortx.run('delegate')) {
      events.push(event);
    }

    expect(events.find((event) => event.type === 'tool_use')).toMatchObject({
      type: 'tool_use',
      toolCall: { toolCallId: 'agent-call', toolName: 'agent' },
    });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      toolCallId: 'agent-call',
      isError: false,
    });
    expect(String(events.find((event) => event.type === 'tool_result')?.result)).toContain('child output');
    expect(lifecycleEvents.find((event) => event.type === 'agent_started')).toMatchObject({
      type: 'agent_started',
      toolCallId: 'agent-call',
    });
    expect(lifecycleEvents.find((event) => event.type === 'agent_completed')).toMatchObject({
      type: 'agent_completed',
      toolCallId: 'agent-call',
      output: 'child output',
    });
  });
});
