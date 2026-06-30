import type { AgentController, AgentEvent } from '../types.js';
import type { LanguageMessage } from '@cortx/sdk';
import { messageText } from '../message-helpers.js';

export type ControlInterruption =
  | { action: 'none' }
  | { action: 'steered'; event: AgentEvent; messages: LanguageMessage[] }
  | { action: 'aborted'; event: AgentEvent };

export function userAbortEvent(reason?: string): AgentEvent {
  return { type: 'error', error: new Error(reason ?? 'aborted'), code: 'user_abort' };
}

export function maxIterationsEvent(iteration: number): AgentEvent {
  return { type: 'error', error: new Error(`Max iterations (${iteration}) reached`), code: 'max_iterations' };
}

export function checkControlInterruption(controller?: AgentController): ControlInterruption {
  if (controller?.isSteered) {
    const messages = controller.consumeSteering();
    const label = messages[0] ? messageText(messages[0]) || 'steered' : 'steered';
    return { action: 'steered', event: { type: 'steered', message: label }, messages };
  }
  if (controller?.isAborted) {
    return { action: 'aborted', event: userAbortEvent(controller.abortReason) };
  }
  return { action: 'none' };
}
