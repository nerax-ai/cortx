import { describe, test, expect, mock } from 'bun:test';
import { TuiStore } from '../store.js';
import { TuiRegistry } from '../tui-registry.js';
import { eventToRegion, processEvent, processEvents } from '../renderer.js';
import type { AgentEvent } from '@cortx/sdk';
import type { TuiExtensionType, TuiFactoryMap, RendererDef } from '../types/tui-plugin.js';
import { TUI_RENDERER } from '../types/tui-plugin.js';
import type { InlinePlugin, PluginContext } from '@nerax-ai/plugin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRendererPlugin(
  id: string,
  renderer: RendererDef,
): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  return {
    manifest: { id, name: id, version: '0.0.0' },
    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
      ctx.register(TUI_RENDERER, id, () => renderer);
    },
  };
}

// ---------------------------------------------------------------------------
// eventToRegion tests
// ---------------------------------------------------------------------------

describe('eventToRegion', () => {
  test('text_delta routes to output region', () => {
    expect(eventToRegion('text_delta')).toBe('output');
  });

  test('thinking_delta routes to output region', () => {
    expect(eventToRegion('thinking_delta')).toBe('output');
  });

  test('text routes to output region', () => {
    expect(eventToRegion('text')).toBe('output');
  });

  test('thinking routes to output region', () => {
    expect(eventToRegion('thinking')).toBe('output');
  });

  test('tool_use routes to tool region', () => {
    expect(eventToRegion('tool_use')).toBe('tool');
  });

  test('tool_progress routes to tool region', () => {
    expect(eventToRegion('tool_progress')).toBe('tool');
  });

  test('tool_result routes to tool region', () => {
    expect(eventToRegion('tool_result')).toBe('tool');
  });

  test('turn_start routes to status region', () => {
    expect(eventToRegion('turn_start')).toBe('status');
  });

  test('turn_end routes to status region', () => {
    expect(eventToRegion('turn_end')).toBe('status');
  });

  test('done routes to status region', () => {
    expect(eventToRegion('done')).toBe('status');
  });

  test('error routes to status region', () => {
    expect(eventToRegion('error')).toBe('status');
  });

  test('steered routes to status region', () => {
    expect(eventToRegion('steered')).toBe('status');
  });

  test('follow_up routes to status region', () => {
    expect(eventToRegion('follow_up')).toBe('status');
  });

  test('context_overflow routes to status region', () => {
    expect(eventToRegion('context_overflow')).toBe('status');
  });
});

// ---------------------------------------------------------------------------
// processEvent tests
// ---------------------------------------------------------------------------

describe('processEvent', () => {
  test('dispatches event to store and updates state', () => {
    const store = new TuiStore();
    const event: AgentEvent = { type: 'text_delta', delta: 'Hello' };

    processEvent(event, store);

    expect(store.getState().messages.currentText).toBe('Hello');
  });

  test('returns empty results without registry', () => {
    const store = new TuiStore();
    const event: AgentEvent = { type: 'text_delta', delta: 'Hello' };

    const results = processEvent(event, store);

    expect(results).toEqual([]);
  });

  test('invokes registered renderer extension for matching event type', () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();
    const renderFn = mock(() => undefined);

    registry.registerPlugin(
      createRendererPlugin('text-renderer', {
        eventType: 'text_delta',
        render: renderFn,
      }),
    );

    const event: AgentEvent = { type: 'text_delta', delta: 'Hello' };
    processEvent(event, store, registry);

    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(renderFn).toHaveBeenCalledWith(event);
  });

  test('does not invoke renderer for non-matching event type', () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();
    const renderFn = mock(() => undefined);

    registry.registerPlugin(
      createRendererPlugin('tool-renderer', {
        eventType: 'tool_use',
        render: renderFn,
      }),
    );

    const event: AgentEvent = { type: 'text_delta', delta: 'Hello' };
    processEvent(event, store, registry);

    expect(renderFn).toHaveBeenCalledTimes(0);
  });

  test('collects renderer results when render returns a value', () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();

    registry.registerPlugin(
      createRendererPlugin('text-renderer', {
        eventType: 'text_delta',
        render: () => 'rendered-output' as unknown as undefined,
      }),
    );

    const event: AgentEvent = { type: 'text_delta', delta: 'Hello' };
    const results = processEvent(event, store, registry);

    expect(results).toEqual(['rendered-output']);
  });

  test('does not collect undefined renderer results', () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();

    registry.registerPlugin(
      createRendererPlugin('text-renderer', {
        eventType: 'text_delta',
        render: () => undefined,
      }),
    );

    const event: AgentEvent = { type: 'text_delta', delta: 'Hello' };
    const results = processEvent(event, store, registry);

    expect(results).toEqual([]);
  });

  test('renderer extension that throws does not interrupt pipeline', () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();

    registry.registerPlugin(
      createRendererPlugin('bad-renderer', {
        eventType: 'text_delta',
        render: () => {
          throw new Error('renderer exploded');
        },
      }),
    );

    const event: AgentEvent = { type: 'text_delta', delta: 'Hello' };

    // Should not throw
    expect(() => processEvent(event, store, registry)).not.toThrow();

    // Store should still be updated
    expect(store.getState().messages.currentText).toBe('Hello');
  });

  test('multiple renderer extensions all get invoked', () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();
    const renderFn1 = mock(() => undefined);
    const renderFn2 = mock(() => undefined);

    registry.registerPlugin(
      createRendererPlugin('renderer-1', {
        eventType: 'text_delta',
        render: renderFn1,
      }),
    );
    registry.registerPlugin(
      createRendererPlugin('renderer-2', {
        eventType: 'text_delta',
        render: renderFn2,
      }),
    );

    const event: AgentEvent = { type: 'text_delta', delta: 'Hello' };
    processEvent(event, store, registry);

    expect(renderFn1).toHaveBeenCalledTimes(1);
    expect(renderFn2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// processEvents (batch) tests
// ---------------------------------------------------------------------------

describe('processEvents', () => {
  test('processes multiple events in sequence', () => {
    const store = new TuiStore();

    const events: AgentEvent[] = [
      { type: 'turn_start', iteration: 1 },
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    processEvents(events, store);

    expect(store.getState().status).toBe('idle');
    expect(store.getState().messages.currentText).toBe('');
    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('Hello world');
    expect(store.getState().iteration).toBe(1);
    expect(store.getState().tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test('full agent turn cycle via batch', () => {
    const store = new TuiStore();

    const events: AgentEvent[] = [
      { type: 'turn_start', iteration: 1 },
      { type: 'text_delta', delta: 'Let me read ' },
      { type: 'text_delta', delta: 'that file.' },
      {
        type: 'tool_use',
        toolCall: {
          type: 'tool-call',
          toolCallId: 'tc_1',
          toolName: 'read_file',
          input: { path: '/tmp/test.txt' },
        },
      },
      { type: 'turn_end', iteration: 1, toolCallCount: 1 },
      {
        type: 'tool_result',
        toolCallId: 'tc_1',
        result: 'file contents',
        isError: false,
      },
      { type: 'turn_start', iteration: 2 },
      { type: 'text_delta', delta: 'Here is the file content.' },
      { type: 'done', usage: { inputTokens: 500, outputTokens: 200 } },
    ];

    processEvents(events, store);

    // Final state
    expect(store.getState().status).toBe('idle');
    expect(store.getState().iteration).toBe(2);
    expect(store.getState().messages.currentText).toBe('');
    // turns: [assistant "Let me read that file."], [tool persisted], [assistant "Here is the file content."]
    expect(store.getState().messages.turns.length).toBe(3);
    expect(store.getState().messages.turns[2].content).toBe('Here is the file content.');
    // turn_start(iteration 2) resets toolCalls, so size is 0
    expect(store.getState().toolCalls.size).toBe(0);
    expect(store.getState().tokenUsage).toEqual({ inputTokens: 500, outputTokens: 200 });
  });
});

// ---------------------------------------------------------------------------
// Selective redraw / region isolation tests
// ---------------------------------------------------------------------------

describe('selective redraw / region isolation', () => {
  test('text_delta updates output region selector only, not status selector', () => {
    const store = new TuiStore();
    const msgListener = mock(() => {});
    const statusListener = mock(() => {});

    const msgSel = store.select((s) => s.messages.currentText);
    const statusSel = store.select((s) => s.status);

    msgSel.subscribe(msgListener);
    statusSel.subscribe(statusListener);

    // text_delta should trigger messages selector but not status selector
    processEvent({ type: 'text_delta', delta: 'Hello' }, store);

    expect(msgListener).toHaveBeenCalledTimes(1);
    expect(statusListener).toHaveBeenCalledTimes(0);

    // Verify values
    expect(msgSel.get()).toBe('Hello');
    expect(statusSel.get()).toBe('idle');
  });

  test('tool_use updates tool region selector only, not messages or status', () => {
    const store = new TuiStore();
    const toolListener = mock(() => {});
    const msgListener = mock(() => {});
    const statusListener = mock(() => {});

    const toolSel = store.select((s) => s.toolCalls);
    const msgSel = store.select((s) => s.messages.currentText);
    const statusSel = store.select((s) => s.status);

    toolSel.subscribe(toolListener);
    msgSel.subscribe(msgListener);
    statusSel.subscribe(statusListener);

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
    );

    // tool_use should only trigger tool selector
    expect(toolListener).toHaveBeenCalledTimes(1);
    expect(msgListener).toHaveBeenCalledTimes(0);
    expect(statusListener).toHaveBeenCalledTimes(0);

    // Verify values
    expect(toolSel.get().size).toBe(1);
    expect(msgSel.get()).toBe('');
    expect(statusSel.get()).toBe('idle');
  });

  test('done updates status and messages selectors but not toolCalls', () => {
    const store = new TuiStore();

    // Set up initial state with some data
    store.dispatch({ type: 'turn_start', iteration: 1 });
    store.dispatch({ type: 'text_delta', delta: 'Hello' });
    store.dispatch({
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'tc_1',
        toolName: 'read_file',
        input: { path: '/tmp/test.txt' },
      },
    });

    // Now subscribe
    const statusListener = mock(() => {});
    const msgListener = mock(() => {});
    const toolListener = mock(() => {});

    store.select((s) => s.status).subscribe(statusListener);
    store.select((s) => s.messages).subscribe(msgListener);
    store.select((s) => s.toolCalls).subscribe(toolListener);

    // Reset mock counts after subscribe (subscribe itself doesn't trigger)
    processEvent(
      { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } },
      store,
    );

    // done changes status (running -> idle) and messages (turns array recreated to
    // prevent shallowEqual misses) but NOT toolCalls
    expect(statusListener).toHaveBeenCalledTimes(1);
    expect(msgListener).toHaveBeenCalledTimes(1);
    expect(toolListener).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: full agent turn sequence
// ---------------------------------------------------------------------------

describe('integration: full agent turn', () => {
  test('all regions update in correct sequence during a turn', () => {
    const store = new TuiStore();

    // Track which selectors fire and in what order
    const updateLog: Array<{ slice: string; value: unknown }> = [];

    store.select((s) => s.status).subscribe(() => {
      updateLog.push({ slice: 'status', value: store.select((s) => s.status).get() });
    });
    store.select((s) => s.messages).subscribe(() => {
      updateLog.push({ slice: 'messages', value: store.select((s) => s.messages.currentText).get() });
    });
    store.select((s) => s.toolCalls).subscribe(() => {
      updateLog.push({ slice: 'toolCalls', value: store.select((s) => s.toolCalls).get().size });
    });

    // 1. turn_start → status changes to running, messages may update (duration calc)
    processEvent({ type: 'turn_start', iteration: 1 }, store);
    expect(store.getState().status).toBe('running');

    // 2. text_delta → messages updated
    processEvent({ type: 'text_delta', delta: 'Let me check ' }, store);
    expect(updateLog.at(-1)).toEqual({ slice: 'messages', value: 'Let me check ' });

    // 3. Another text_delta
    processEvent({ type: 'text_delta', delta: 'the file.' }, store);
    expect(updateLog.at(-1)).toEqual({ slice: 'messages', value: 'Let me check the file.' });

    // 4. tool_use → toolCalls updated
    processEvent(
      {
        type: 'tool_use',
        toolCall: {
          type: 'tool-call',
          toolCallId: 'tc_1',
          toolName: 'bash',
          input: { command: 'cat /tmp/test.txt' },
        },
      },
      store,
    );
    expect(updateLog.at(-1)).toEqual({ slice: 'toolCalls', value: 1 });

    // 5. tool_result → toolCalls updated again
    processEvent(
      {
        type: 'tool_result',
        toolCallId: 'tc_1',
        result: 'file contents here',
        isError: false,
      },
      store,
    );
    expect(updateLog.at(-1)).toEqual({ slice: 'toolCalls', value: 1 });

    // 6. done → messages updated (turn pushed, currentText cleared) and status changes to idle
    processEvent(
      { type: 'done', usage: { inputTokens: 500, outputTokens: 200 } },
      store,
    );

    // Verify final state
    expect(store.getState().status).toBe('idle');
    expect(store.getState().messages.currentText).toBe('');
    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('Let me check the file.');
    expect(store.getState().toolCalls.size).toBe(1);
    expect(store.getState().toolCalls.get('tc_1')!.toolName).toBe('bash');
    expect(store.getState().toolCalls.get('tc_1')!.status).toBe('complete');
    expect(store.getState().tokenUsage).toEqual({ inputTokens: 500, outputTokens: 200 });

    // Verify update sequence (turn_start may fire messages + status)
    const sliceSequence = updateLog.map((e) => e.slice);
    expect(sliceSequence.slice(0, 2)).toContain('status');  // turn_start fires status
    expect(sliceSequence).toContain('messages');  // text_deltas fire messages
    expect(sliceSequence).toContain('toolCalls'); // tool_use and tool_result fire toolCalls
    // done fires both messages (turns array updated) and status (idle)
    expect(sliceSequence).toContain('status');
    expect(sliceSequence).toContain('messages');
  });

  test('multi-turn conversation accumulates correctly through renderer', () => {
    const store = new TuiStore();

    // Turn 1
    processEvents(
      [
        { type: 'turn_start', iteration: 1 },
        { type: 'text_delta', delta: 'Hello!' },
        { type: 'done', usage: { inputTokens: 50, outputTokens: 10 } },
      ],
      store,
    );

    expect(store.getState().status).toBe('idle');
    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('Hello!');
    expect(store.getState().messages.currentText).toBe('');

    // Turn 2 - turns accumulate across cycles
    processEvents(
      [
        { type: 'turn_start', iteration: 2 },
        { type: 'text_delta', delta: 'World!' },
        { type: 'done', usage: { inputTokens: 80, outputTokens: 15 } },
      ],
      store,
    );

    expect(store.getState().messages.turns.length).toBe(2);
    expect(store.getState().messages.turns[1].content).toBe('World!');
    expect(store.getState().messages.currentText).toBe('');
    // Token usage accumulates
    expect(store.getState().tokenUsage).toEqual({ inputTokens: 130, outputTokens: 25 });
  });

  test('error during turn updates status correctly', () => {
    const store = new TuiStore();

    processEvents(
      [
        { type: 'turn_start', iteration: 1 },
        { type: 'text_delta', delta: 'Working...' },
        { type: 'error', error: new Error('API rate limit'), code: 'rate_limited' },
      ],
      store,
    );

    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toBe('API rate limit');
    expect(store.getState().messages.turns.length).toBe(1);
    expect(store.getState().messages.turns[0].content).toBe('Working...');
    expect(store.getState().messages.currentText).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Renderer extension integration
// ---------------------------------------------------------------------------

describe('renderer extension integration', () => {
  test('renderer can augment rendering for text_delta events', () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();
    const renderedEvents: AgentEvent[] = [];

    registry.registerPlugin(
      createRendererPlugin('custom-text-renderer', {
        eventType: 'text_delta',
        render: (event) => {
          renderedEvents.push(event);
          return undefined;
        },
      }),
    );

    processEvent({ type: 'text_delta', delta: 'Hello' }, store, registry);

    expect(renderedEvents.length).toBe(1);
    expect(renderedEvents[0].type).toBe('text_delta');
  });

  test('renderer extensions for different event types coexist', () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();
    const textEvents: AgentEvent[] = [];
    const toolEvents: AgentEvent[] = [];

    registry.registerPlugin(
      createRendererPlugin('text-renderer', {
        eventType: 'text_delta',
        render: (event) => {
          textEvents.push(event);
          return undefined;
        },
      }),
    );
    registry.registerPlugin(
      createRendererPlugin('tool-renderer', {
        eventType: 'tool_use',
        render: (event) => {
          toolEvents.push(event);
          return undefined;
        },
      }),
    );

    // Process text event
    processEvent({ type: 'text_delta', delta: 'Hello' }, store, registry);
    expect(textEvents.length).toBe(1);
    expect(toolEvents.length).toBe(0);

    // Process tool event
    processEvent(
      {
        type: 'tool_use',
        toolCall: {
          type: 'tool-call',
          toolCallId: 'tc_1',
          toolName: 'bash',
          input: { command: 'ls' },
        },
      },
      store,
      registry,
    );
    expect(textEvents.length).toBe(1);
    expect(toolEvents.length).toBe(1);
  });

  test('processEvents invokes renderers for each event', () => {
    const store = new TuiStore();
    const registry = new TuiRegistry();
    const allRendered: string[] = [];

    registry.registerPlugin(
      createRendererPlugin('delta-renderer', {
        eventType: 'text_delta',
        render: (event) => {
          allRendered.push((event as { delta: string }).delta);
          return undefined;
        },
      }),
    );

    processEvents(
      [
        { type: 'turn_start', iteration: 1 },
        { type: 'text_delta', delta: 'chunk1' },
        { type: 'text_delta', delta: 'chunk2' },
        { type: 'text_delta', delta: 'chunk3' },
        { type: 'done' },
      ],
      store,
      registry,
    );

    expect(allRendered).toEqual(['chunk1', 'chunk2', 'chunk3']);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('empty events array is handled by processEvents', () => {
    const store = new TuiStore();
    expect(() => processEvents([], store)).not.toThrow();
    expect(store.getState().status).toBe('idle');
  });

  test('tool_progress event is routed to tool region', () => {
    const store = new TuiStore();

    // Set up a tool call first
    store.dispatch({
      type: 'tool_use',
      toolCall: {
        type: 'tool-call',
        toolCallId: 'tc_1',
        toolName: 'bash',
        input: { command: 'long-running-task' },
      },
    });

    // tool_progress doesn't change state currently, but routes to tool region
    expect(eventToRegion('tool_progress')).toBe('tool');
    expect(() =>
      processEvent(
        { type: 'tool_progress', toolCallId: 'tc_1', text: '50% complete' },
        store,
      ),
    ).not.toThrow();
  });

  test('steered event routes to status region', () => {
    expect(eventToRegion('steered')).toBe('status');
    const store = new TuiStore();
    processEvent({ type: 'steered', message: 'new direction' }, store);
    // steered doesn't change state, but should not throw
    expect(store.getState().status).toBe('idle');
  });

  test('follow_up event routes to status region', () => {
    expect(eventToRegion('follow_up')).toBe('status');
    const store = new TuiStore();
    processEvent({ type: 'follow_up', message: 'continue' }, store);
    expect(store.getState().status).toBe('idle');
  });

  test('context_overflow event routes to status region', () => {
    expect(eventToRegion('context_overflow')).toBe('status');
    const store = new TuiStore();
    processEvent({ type: 'context_overflow', messages: [] }, store);
    expect(store.getState().status).toBe('idle');
  });
});
