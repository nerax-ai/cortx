import type { LanguageMessage } from '@cortx/sdk';
import type { TurnEntry } from './types/tui-state.js';

/**
 * Parse runtime data into LanguageMessage[].
 *
 * Session data is loaded from JSON — types don't exist at runtime.
 * This function is the single trusted boundary where untyped data
 * enters the typed system.
 */
export function parseAgentMessages(data: unknown): LanguageMessage[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && 'role' in item,
  ) as unknown as LanguageMessage[];
}

/** Map TurnEntry records to message-shaped objects. */
export function turnsToMessages(turns: TurnEntry[]): LanguageMessage[] {
  return turns.map((t) => ({
    role: t.role,
    content: t.content,
  })) as unknown as LanguageMessage[];
}
