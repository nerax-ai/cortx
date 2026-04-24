/**
 * Shared color constants for the TUI.
 *
 * Use these instead of hardcoded color strings to keep the
 * visual language consistent across all components.
 */
export const colors = {
  userMessage: 'cyan',
  assistantText: undefined as string | undefined,
  toolSuccess: 'green',
  toolPending: 'yellow',
  toolError: 'red',
  activityThinking: 'yellow',
  activityExecuting: 'cyan',
  activityIdle: 'green',
  activityError: 'red',
  activityInterrupt: 'red',
  border: 'gray',
  prompt: 'green',
  link: 'cyan',
  diffAdd: 'green',
  diffRemove: 'red',
  thinking: 'yellow',
} as const;
