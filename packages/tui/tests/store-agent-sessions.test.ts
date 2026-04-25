import { describe, test, expect, mock } from 'bun:test';
import { TuiStore, selectAgentSessions, selectActiveAgentView } from '../src/store.js';
import type { AgentSessionSummary } from '../src/types/tui-state.js';

describe('TuiStore agent session tracking', () => {
  // --- agent_started creates entry ---

  test('agent_started creates an AgentSessionSummary entry', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_1',
      description: 'Build a feature',
    });

    const sessions = store.getState().agentSessions;
    expect(sessions.size).toBe(1);

    const entry = sessions.get('agent_1');
    expect(entry).toBeDefined();
    expect(entry!.toolCallId).toBe('agent_1');
    expect(entry!.description).toBe('Build a feature');
    expect(entry!.status).toBe('running');
    expect(entry!.isBackground).toBe(false);
    expect(entry!.iterations).toBe(0);
    expect(entry!.toolCallCount).toBe(0);
    expect(entry!.progress).toBeUndefined();
  });

  // --- agent_progress updates progress ---

  test('agent_progress updates progress text on matching entry', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_1',
      description: 'Research task',
    });

    store.dispatch({
      type: 'agent_progress',
      toolCallId: 'agent_1',
      text: 'Reading files...',
    });

    const entry = store.getState().agentSessions.get('agent_1');
    expect(entry!.progress).toBe('Reading files...');
  });

  test('agent_progress for unknown toolCallId is a no-op', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_1',
      description: 'Task A',
    });

    // Progress for a non-existent agent should not crash
    expect(() => {
      store.dispatch({
        type: 'agent_progress',
        toolCallId: 'unknown_agent',
        text: 'Some progress',
      });
    }).not.toThrow();

    // Existing entry should be unchanged
    const entry = store.getState().agentSessions.get('agent_1');
    expect(entry!.progress).toBeUndefined();
  });

  // --- agent_completed finalizes ---

  test('agent_completed finalizes status and counters', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_1',
      description: 'Build feature',
    });

    store.dispatch({
      type: 'agent_progress',
      toolCallId: 'agent_1',
      text: 'Working...',
    });

    store.dispatch({
      type: 'agent_completed',
      toolCallId: 'agent_1',
      output: 'Done building',
      iterations: 5,
      toolCallCount: 12,
    });

    const entry = store.getState().agentSessions.get('agent_1');
    expect(entry!.status).toBe('completed');
    expect(entry!.iterations).toBe(5);
    expect(entry!.toolCallCount).toBe(12);
    // Progress should still be preserved from last agent_progress
    expect(entry!.progress).toBe('Working...');
  });

  test('agent_completed with isError sets status to error', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_err',
      description: 'Failing task',
    });

    store.dispatch({
      type: 'agent_completed',
      toolCallId: 'agent_err',
      output: 'Something went wrong',
      iterations: 2,
      toolCallCount: 3,
      isError: true,
    });

    const entry = store.getState().agentSessions.get('agent_err');
    expect(entry!.status).toBe('error');
    expect(entry!.iterations).toBe(2);
    expect(entry!.toolCallCount).toBe(3);
  });

  test('agent_completed for unknown toolCallId is a no-op', () => {
    const store = new TuiStore();

    expect(() => {
      store.dispatch({
        type: 'agent_completed',
        toolCallId: 'nonexistent',
        output: '',
        iterations: 0,
        toolCallCount: 0,
      });
    }).not.toThrow();

    expect(store.getState().agentSessions.size).toBe(0);
  });

  // --- Multiple agents tracked independently ---

  test('multiple agents are tracked independently', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_a',
      description: 'Task A',
    });

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_b',
      description: 'Task B',
    });

    store.dispatch({
      type: 'agent_progress',
      toolCallId: 'agent_a',
      text: 'A working...',
    });

    store.dispatch({
      type: 'agent_progress',
      toolCallId: 'agent_b',
      text: 'B working...',
    });

    store.dispatch({
      type: 'agent_completed',
      toolCallId: 'agent_a',
      output: 'A done',
      iterations: 3,
      toolCallCount: 7,
    });

    const sessions = store.getState().agentSessions;
    expect(sessions.size).toBe(2);

    const a = sessions.get('agent_a');
    const b = sessions.get('agent_b');

    expect(a!.status).toBe('completed');
    expect(a!.iterations).toBe(3);
    expect(a!.toolCallCount).toBe(7);

    expect(b!.status).toBe('running');
    expect(b!.progress).toBe('B working...');
    expect(b!.iterations).toBe(0);
  });

  // --- setActiveAgentView ---

  test('setActiveAgentView sets the view to a toolCallId', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_1',
      description: 'Task 1',
    });

    store.setActiveAgentView('agent_1');
    expect(store.getState().activeAgentView).toBe('agent_1');
  });

  test('setActiveAgentView clears the view when passed null', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_1',
      description: 'Task 1',
    });

    store.setActiveAgentView('agent_1');
    expect(store.getState().activeAgentView).toBe('agent_1');

    store.setActiveAgentView(null);
    expect(store.getState().activeAgentView).toBeNull();
  });

  test('setActiveAgentView notifies subscribers', () => {
    const store = new TuiStore();
    const listener = mock(() => {});
    const sel = store.select(selectActiveAgentView);

    sel.subscribe(listener);

    store.setActiveAgentView('agent_1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(sel.get()).toBe('agent_1');
  });

  // --- Reset clears everything ---

  test('reset clears agentSessions and activeAgentView', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_1',
      description: 'Task 1',
    });

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_2',
      description: 'Task 2',
    });

    store.setActiveAgentView('agent_1');

    expect(store.getState().agentSessions.size).toBe(2);
    expect(store.getState().activeAgentView).toBe('agent_1');

    store.reset();

    expect(store.getState().agentSessions.size).toBe(0);
    expect(store.getState().activeAgentView).toBeNull();
  });

  // --- Selectors ---

  test('selectAgentSessions returns the agent sessions map', () => {
    const store = new TuiStore();

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_1',
      description: 'Task 1',
    });

    const sel = store.select(selectAgentSessions);
    expect(sel.get().size).toBe(1);
    expect(sel.get().get('agent_1')!.description).toBe('Task 1');
  });

  test('selectActiveAgentView returns current active view', () => {
    const store = new TuiStore();

    const sel = store.select(selectActiveAgentView);
    expect(sel.get()).toBeNull();

    store.setActiveAgentView('agent_x');
    expect(sel.get()).toBe('agent_x');
  });

  test('selectAgentSessions notifies on agent events', () => {
    const store = new TuiStore();
    const listener = mock(() => {});
    const sel = store.select(selectAgentSessions);

    sel.subscribe(listener);

    store.dispatch({
      type: 'agent_started',
      toolCallId: 'agent_1',
      description: 'Task 1',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(sel.get().size).toBe(1);
  });
});
