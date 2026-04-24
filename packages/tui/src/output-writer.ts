/**
 * Output writer — writes completed turns to the terminal via console.log.
 *
 * When Ink's `patchConsole` is enabled, console.log output appears ABOVE the
 * Ink frame and is preserved in the terminal scrollback. This gives native
 * terminal scrolling, copy support, and natural output flow.
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

/** Write a user message to the terminal. */
export function writeUserMessage(text: string): void {
  const tag = `${ANSI.bold}${ANSI.cyan}>${ANSI.reset}`;
  console.log(`${tag} ${text}`);
}

/** Write an assistant message to the terminal. */
export function writeAssistantMessage(text: string, duration?: number): void {
  const durationTag = duration != null && duration > 0.1
    ? ` ${ANSI.dim}(${duration.toFixed(1)}s)${ANSI.reset}`
    : '';
  console.log(`${text}${durationTag}`);
}

/** Write a tool turn to the terminal. */
export function writeToolMessage(content: string): void {
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.startsWith('✓') || line.startsWith('✅')) {
      console.log(`  ${ANSI.green}${line}${ANSI.reset}`);
    } else if (line.startsWith('✗')) {
      console.log(`  ${ANSI.red}${line}${ANSI.reset}`);
    } else if (line.startsWith('⏳')) {
      console.log(`  ${ANSI.yellow}${line}${ANSI.reset}`);
    } else {
      console.log(`  ${ANSI.dim}${line}${ANSI.reset}`);
    }
  }
}

/** Write a separator between turns. */
export function writeSeparator(): void {
  console.log(`${ANSI.dim}${'─'.repeat(60)}${ANSI.reset}`);
}

/**
 * Write a completed turn to the terminal.
 * Called when a turn is finalized (e.g., on turn_start to flush the previous turn,
 * or on done/error to flush the last turn).
 */
export function writeTurn(turn: TurnEntry): void {
  switch (turn.role) {
    case 'user':
      writeUserMessage(turn.content);
      break;
    case 'assistant':
      writeAssistantMessage(turn.content, turn.duration);
      break;
    case 'tool':
      writeToolMessage(turn.content);
      break;
  }
}
