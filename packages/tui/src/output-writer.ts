/**
 * Output writer — formats completed turns for terminal output.
 *
 * All functions return strings. The caller batches them into a single
 * console.log call to avoid corrupting Ink's patchConsole frame tracking.
 */

import type { TurnEntry } from './types/tui-state.js';

const ANSI = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  cyan: '\x1B[36m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  red: '\x1B[31m',
  gray: '\x1B[90m',
} as const;

/** Format a user message. */
export function formatUserMessage(text: string): string {
  const tag = `${ANSI.bold}${ANSI.cyan}>${ANSI.reset}`;
  return `${tag} ${text}`;
}

/** Format an assistant message. */
export function formatAssistantMessage(text: string, duration?: number): string {
  const durationTag = duration != null && duration > 0.1
    ? ` ${ANSI.dim}(${duration.toFixed(1)}s)${ANSI.reset}`
    : '';
  return `${text}${durationTag}`;
}

/** Format a tool turn. */
export function formatToolMessage(content: string): string {
  const lines = content.split('\n');
  return lines.map(line => {
    if (line.startsWith('✓') || line.startsWith('✅')) {
      return `  ${ANSI.green}${line}${ANSI.reset}`;
    } else if (line.startsWith('✗')) {
      return `  ${ANSI.red}${line}${ANSI.reset}`;
    } else if (line.startsWith('⏳')) {
      return `  ${ANSI.yellow}${line}${ANSI.reset}`;
    } else {
      return `  ${ANSI.dim}${line}${ANSI.reset}`;
    }
  }).join('\n');
}

/** Format a separator between turns. */
export function formatSeparator(): string {
  return `${ANSI.dim}${'─'.repeat(60)}${ANSI.reset}`;
}

/** Format a completed turn. */
export function formatTurn(turn: TurnEntry): string {
  switch (turn.role) {
    case 'user':
      return formatUserMessage(turn.content);
    case 'assistant':
      return formatAssistantMessage(turn.content, turn.duration);
    case 'tool':
      return formatToolMessage(turn.content);
    default:
      return turn.content;
  }
}
