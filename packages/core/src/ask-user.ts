import type { AgentLoopController } from './types.js';
import type { AgentEvent } from '@cortx/sdk';

/**
 * Creates an askUser callback that uses the controller's Promise-based gate.
 *
 * When called, it:
 * 1. Registers a pending question on the controller
 * 2. Emits a user_question event via onEvent
 * 3. Returns the Promise (tool execution blocks until resolved)
 */
export function createAskUserCallback(
  controller: AgentLoopController,
  onEvent: (event: AgentEvent) => void,
  timeoutMs = 120_000,
): (question: string, toolCallId: string) => Promise<string> {
  return (question: string, toolCallId: string): Promise<string> => {
    onEvent({ type: 'user_question', question, toolCallId });
    return controller.registerQuestion(toolCallId, timeoutMs);
  };
}
