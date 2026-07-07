/**
 * Renderer — event-to-region routing pipeline.
 *
 * Maps AgentEvent types to state store dispatches and optionally invokes
 * registered tui.renderer extensions. This is a pure function module,
 * NOT a React component.
 *
 * Event routing:
 *   user_message / text_delta / thinking_delta / text / thinking → output region
 *   tool_use / tool_progress / tool_result        → tool region
 *   turn_start / turn_end / done / error           → status bar
 *   steered / follow_up / context_overflow         → status bar (notifications)
 */

import type { AgentEvent } from '@cortx/sdk';
import type { TuiStore } from './store.js';
import type { TuiRegistry } from './tui-registry.js';

/** Region identifiers for event routing. */
export type RegionTarget = 'output' | 'tool' | 'status';

/**
 * Map an AgentEvent type to the region(s) it targets.
 */
export function eventToRegion(eventType: AgentEvent['type']): RegionTarget {
  switch (eventType) {
    case 'user_message':
    case 'text_delta':
    case 'thinking_delta':
    case 'text':
    case 'thinking':
      return 'output';

    case 'tool_use':
    case 'tool_progress':
    case 'tool_result':
      return 'tool';

    case 'turn_start':
    case 'turn_end':
    case 'done':
    case 'error':
    case 'steered':
    case 'follow_up':
    case 'context_overflow':
    case 'agent_started':
    case 'agent_progress':
    case 'agent_completed':
      return 'status';

    default:
      return 'status';
  }
}

/**
 * Process an AgentEvent through the renderer pipeline.
 */
export function processEvent(
  event: AgentEvent,
  store: TuiStore,
  registry?: TuiRegistry,
): unknown[] {
  // 1. Dispatch to store — this updates the relevant state slice
  store.dispatch(event);

  // 2. Invoke registered renderer extensions
  const results: unknown[] = [];

  if (registry) {
    const renderers = registry.getRenderers(event.type);
    for (const renderer of renderers) {
      try {
        const result = renderer.render(event);
        if (result !== undefined) {
          results.push(result);
        }
      } catch {
        // Renderer extensions are isolated — errors are logged but don't
        // interrupt the pipeline. The registry already logs errors from
        // getRenderers(), but render() itself could throw too.
      }
    }
  }

  return results;
}

/**
 * Batch-process an array of AgentEvents.
 *
 * Useful for replay or initialization where multiple events
 * need to flow through the pipeline.
 */
export function processEvents(
  events: AgentEvent[],
  store: TuiStore,
  registry?: TuiRegistry,
): void {
  for (const event of events) {
    processEvent(event, store, registry);
  }
}
