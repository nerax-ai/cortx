import { describe, test, expect } from 'bun:test';
import {
  navigateHistory,
  pushHistory,
  getCursorPosition,
  insertText,
  separator,
  composerBorderColor,
  handleBackspace,
  resolveCtrlCAction,
  helpText,
  activityLabel,
  openInEditor,
  visibleInputLines,
  type CtrlCAction,
} from '../components/input-area.js';
import { submitInput } from '../app.js';

// ---------------------------------------------------------------------------
// navigateHistory
// ---------------------------------------------------------------------------

describe('navigateHistory', () => {
  test('returns empty value when history is empty (up)', () => {
    const result = navigateHistory([], -1, 'up');
    expect(result.value).toBe('');
    expect(result.historyIndex).toBe(-1);
  });

  test('returns empty value when history is empty (down)', () => {
    const result = navigateHistory([], -1, 'down');
    expect(result.value).toBe('');
    expect(result.historyIndex).toBe(-1);
  });

  test('up navigates to older entries', () => {
    const history = ['first', 'second', 'third'];
    let result = navigateHistory(history, -1, 'up');
    expect(result.value).toBe('first');
    expect(result.historyIndex).toBe(0);

    result = navigateHistory(history, 0, 'up');
    expect(result.value).toBe('second');
    expect(result.historyIndex).toBe(1);

    result = navigateHistory(history, 1, 'up');
    expect(result.value).toBe('third');
    expect(result.historyIndex).toBe(2);
  });

  test('up stops at the oldest entry', () => {
    const history = ['first', 'second'];
    const result = navigateHistory(history, 1, 'up');
    expect(result.value).toBe('second');
    expect(result.historyIndex).toBe(1);
  });

  test('down navigates to newer entries', () => {
    const history = ['first', 'second'];
    let result = navigateHistory(history, 1, 'down');
    expect(result.value).toBe('first');
    expect(result.historyIndex).toBe(0);

    result = navigateHistory(history, 0, 'down');
    expect(result.value).toBe('');
    expect(result.historyIndex).toBe(-1);
  });

  test('down stops at -1 returning empty string', () => {
    const history = ['first'];
    const result = navigateHistory(history, -1, 'down');
    expect(result.value).toBe('');
    expect(result.historyIndex).toBe(-1);
  });

  test('does not mutate history array', () => {
    const history = ['a', 'b'];
    const historyCopy = [...history];
    navigateHistory(history, -1, 'up');
    expect(history).toEqual(historyCopy);
  });
});

// ---------------------------------------------------------------------------
// pushHistory
// ---------------------------------------------------------------------------

describe('pushHistory', () => {
  test('adds value to front of history', () => {
    const result = pushHistory([], 'hello');
    expect(result).toEqual(['hello']);
  });

  test('adds to front, pushing existing entries back', () => {
    const result = pushHistory(['old'], 'new');
    expect(result).toEqual(['new', 'old']);
  });

  test('skips consecutive duplicates', () => {
    const result = pushHistory(['hello'], 'hello');
    expect(result).toEqual(['hello']);
  });

  test('allows non-consecutive duplicates', () => {
    const result = pushHistory(['hello', 'world'], 'hello');
    expect(result).toEqual(['hello', 'world']);
  });

  test('trims whitespace before comparison', () => {
    const result = pushHistory([], '  hello  ');
    expect(result).toEqual(['hello']);
  });

  test('ignores empty/whitespace-only values', () => {
    expect(pushHistory(['a'], '')).toEqual(['a']);
    expect(pushHistory(['a'], '   ')).toEqual(['a']);
  });

  test('caps at 1000 entries', () => {
    const longHistory = Array.from({ length: 1000 }, (_, i) => `entry-${i}`);
    const result = pushHistory(longHistory, 'new-entry');
    expect(result.length).toBe(1000);
    expect(result[0]).toBe('new-entry');
    expect(result[999]).toBe('entry-998');
  });
});

// ---------------------------------------------------------------------------
// getCursorPosition
// ---------------------------------------------------------------------------

describe('getCursorPosition', () => {
  test('empty string returns row 0, col 0', () => {
    const pos = getCursorPosition('');
    expect(pos).toEqual({ row: 0, col: 0 });
  });

  test('single line positions at end of line', () => {
    const pos = getCursorPosition('hello');
    expect(pos).toEqual({ row: 0, col: 5 });
  });

  test('multi-line positions at end of last line', () => {
    const pos = getCursorPosition('line1\nline2\nab');
    expect(pos).toEqual({ row: 2, col: 2 });
  });

  test('trailing newline creates new empty line', () => {
    const pos = getCursorPosition('hello\n');
    expect(pos).toEqual({ row: 1, col: 0 });
  });

  test('multiple trailing newlines', () => {
    const pos = getCursorPosition('hello\n\n');
    expect(pos).toEqual({ row: 2, col: 0 });
  });
});

// ---------------------------------------------------------------------------
// insertText
// ---------------------------------------------------------------------------

describe('insertText', () => {
  test('appends text to value', () => {
    expect(insertText('hello', ' world')).toBe('hello world');
  });

  test('appends to empty string', () => {
    expect(insertText('', 'start')).toBe('start');
  });
});

describe('separator', () => {
  test('uses a minimum width for narrow terminals', () => {
    expect(separator(10)).toHaveLength(24);
  });

  test('caps very wide terminals', () => {
    expect(separator(240)).toHaveLength(120);
  });

  test('uses the terminal width inside bounds', () => {
    expect(separator(88)).toHaveLength(88);
  });
});

describe('helpText', () => {
  test('shows palette hints while palette is open', () => {
    expect(helpText(false, true)).toContain('Esc close');
  });

  test('shows interrupt hint while running', () => {
    expect(helpText(true, false)).toContain('Ctrl+C interrupt');
  });

  test('shows send and command hints while idle', () => {
    const text = helpText(false, false);
    expect(text).toContain('Enter send');
    expect(text).toContain('/ commands');
  });

  test('uses shorter idle hint on narrow terminals', () => {
    expect(helpText(false, false, 72)).not.toContain('Ctrl+E editor');
  });
});

describe('visibleInputLines', () => {
  test('keeps short input unchanged', () => {
    expect(visibleInputLines('a\nb', 4)).toEqual({ lines: ['a', 'b'], hiddenCount: 0 });
  });

  test('keeps the latest lines for long input', () => {
    expect(visibleInputLines('a\nb\nc\nd\ne', 3)).toEqual({
      lines: ['c', 'd', 'e'],
      hiddenCount: 2,
    });
  });
});

describe('composerBorderColor', () => {
  test('uses active border while palette is open', () => {
    expect(composerBorderColor('idle', true)).toBe('cyan');
  });

  test('uses error border for error status', () => {
    expect(composerBorderColor('error', false)).toBe('red');
  });

  test('uses active border while running', () => {
    expect(composerBorderColor('running', false)).toBe('cyan');
  });
});

describe('activityLabel', () => {
  test('uses tool name while executing', () => {
    const toolCalls = new Map([['tc_1', { status: 'pending', toolName: 'read' }]]);
    expect(
      activityLabel('executing', {
        toolCalls,
      }),
    ).toBe('running read');
  });

  test('uses concise thinking label', () => {
    expect(
      activityLabel('thinking', {
        toolCalls: new Map(),
      }),
    ).toBe('thinking');
  });

  test('uses error label for error activity', () => {
    expect(
      activityLabel('error', {
        toolCalls: new Map(),
      }),
    ).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// handleBackspace
// ---------------------------------------------------------------------------

describe('handleBackspace', () => {
  test('removes last character', () => {
    expect(handleBackspace('hello')).toBe('hell');
  });

  test('handles empty string', () => {
    expect(handleBackspace('')).toBe('');
  });

  test('removes newline, joining lines', () => {
    expect(handleBackspace('line1\n')).toBe('line1');
  });

  test('removes character from middle of multi-line', () => {
    expect(handleBackspace('ab\ncd')).toBe('ab\nc');
  });
});

// ---------------------------------------------------------------------------
// resolveCtrlCAction
// ---------------------------------------------------------------------------

describe('resolveCtrlCAction', () => {
  test('idle + non-empty input => clear', () => {
    expect(resolveCtrlCAction('idle', 'some text')).toBe<CtrlCAction>('clear');
  });

  test('idle + empty input => exit', () => {
    expect(resolveCtrlCAction('idle', '')).toBe<CtrlCAction>('exit');
  });

  test('running + any input => abort', () => {
    expect(resolveCtrlCAction('running', '')).toBe<CtrlCAction>('abort');
    expect(resolveCtrlCAction('running', 'typing')).toBe<CtrlCAction>('abort');
  });

  test('interrupting + any input => force-exit', () => {
    expect(resolveCtrlCAction('interrupting', '')).toBe<CtrlCAction>('force-exit');
    expect(resolveCtrlCAction('interrupting', 'text')).toBe<CtrlCAction>('force-exit');
  });
});

// ---------------------------------------------------------------------------
// openInEditor
// ---------------------------------------------------------------------------

describe('openInEditor', () => {
  test('returns null when EDITOR is set to a non-existent command', () => {
    const origEditor = process.env.EDITOR;
    const origVisual = process.env.VISUAL;
    process.env.EDITOR = '/nonexistent-editor-binary-xyz';
    delete process.env.VISUAL;

    const result = openInEditor('test content');
    expect(result).toBeNull();

    // Restore
    if (origEditor) process.env.EDITOR = origEditor;
    else delete process.env.EDITOR;
    if (origVisual) process.env.VISUAL = origVisual;
    else delete process.env.VISUAL;
  });

  test('returns content when editor succeeds (using cat as editor)', () => {
    const origEditor = process.env.EDITOR;
    const origVisual = process.env.VISUAL;
    // Use 'cat' which reads the file to stdout but doesn't write back.
    // This means content stays unchanged — spawnSync returns status 0.
    // Actually 'cat' exits with 0 but doesn't modify the file, so we
    // should get the same content back.
    // Better: use 'true' which exits 0 without modifying the file.
    process.env.EDITOR = 'true';
    delete process.env.VISUAL;

    const result = openInEditor('initial content');
    expect(result).toBe('initial content');

    // Restore
    if (origEditor) process.env.EDITOR = origEditor;
    else delete process.env.EDITOR;
    if (origVisual) process.env.VISUAL = origVisual;
    else delete process.env.VISUAL;
  });

  test('returns trimmed content', () => {
    const origEditor = process.env.EDITOR;
    const origVisual = process.env.VISUAL;
    process.env.EDITOR = 'true';
    delete process.env.VISUAL;

    const result = openInEditor('  padded content  \n');
    expect(result).toBe('padded content');

    // Restore
    if (origEditor) process.env.EDITOR = origEditor;
    else delete process.env.EDITOR;
    if (origVisual) process.env.VISUAL = origVisual;
    else delete process.env.VISUAL;
  });
});

// ---------------------------------------------------------------------------
// Integration: history + navigation scenario
// ---------------------------------------------------------------------------

describe('Integration: history navigation flow', () => {
  test('typical usage: submit messages then navigate back', () => {
    let history: string[] = [];
    let historyIndex = -1;
    let value = '';

    // User submits three messages
    history = pushHistory(history, 'first message');
    history = pushHistory(history, 'second message');
    history = pushHistory(history, 'third message');

    expect(history).toEqual(['third message', 'second message', 'first message']);

    // User presses Up — should see most recent
    let result = navigateHistory(history, historyIndex, 'up');
    historyIndex = result.historyIndex;
    value = result.value;
    expect(value).toBe('third message');
    expect(historyIndex).toBe(0);

    // User presses Up again — second most recent
    result = navigateHistory(history, historyIndex, 'up');
    historyIndex = result.historyIndex;
    value = result.value;
    expect(value).toBe('second message');
    expect(historyIndex).toBe(1);

    // User presses Up again — oldest
    result = navigateHistory(history, historyIndex, 'up');
    historyIndex = result.historyIndex;
    value = result.value;
    expect(value).toBe('first message');
    expect(historyIndex).toBe(2);

    // User presses Up again — stays at oldest
    result = navigateHistory(history, historyIndex, 'up');
    historyIndex = result.historyIndex;
    value = result.value;
    expect(value).toBe('first message');
    expect(historyIndex).toBe(2);

    // User presses Down — goes to second
    result = navigateHistory(history, historyIndex, 'down');
    historyIndex = result.historyIndex;
    value = result.value;
    expect(value).toBe('second message');
    expect(historyIndex).toBe(1);

    // User presses Down — goes to third
    result = navigateHistory(history, historyIndex, 'down');
    historyIndex = result.historyIndex;
    value = result.value;
    expect(value).toBe('third message');
    expect(historyIndex).toBe(0);

    // User presses Down — goes to empty (newest)
    result = navigateHistory(history, historyIndex, 'down');
    historyIndex = result.historyIndex;
    value = result.value;
    expect(value).toBe('');
    expect(historyIndex).toBe(-1);

    // User presses Down at -1 — stays
    result = navigateHistory(history, historyIndex, 'down');
    historyIndex = result.historyIndex;
    value = result.value;
    expect(value).toBe('');
    expect(historyIndex).toBe(-1);
  });

  test('duplicate submit does not create consecutive entries', () => {
    let history: string[] = [];

    history = pushHistory(history, 'hello');
    history = pushHistory(history, 'world');
    history = pushHistory(history, 'world'); // consecutive duplicate

    expect(history).toEqual(['world', 'hello']);
  });
});

// ---------------------------------------------------------------------------
// Integration: Ctrl+C state machine through agent lifecycle
// ---------------------------------------------------------------------------

describe('Integration: Ctrl+C lifecycle', () => {
  test('idle -> type -> Ctrl+C clears -> Ctrl+C exits', () => {
    // Start idle
    let action = resolveCtrlCAction('idle', '');
    expect(action).toBe<CtrlCAction>('exit');

    // User types something
    const inputValue = 'some text';
    action = resolveCtrlCAction('idle', inputValue);
    expect(action).toBe<CtrlCAction>('clear');

    // Input is cleared (empty again)
    action = resolveCtrlCAction('idle', '');
    expect(action).toBe<CtrlCAction>('exit');
  });

  test('running -> Ctrl+C aborts -> interrupting -> Ctrl+C force-exits', () => {
    // Agent starts running
    let action = resolveCtrlCAction('running', '');
    expect(action).toBe<CtrlCAction>('abort');

    // After abort, status transitions to interrupting
    action = resolveCtrlCAction('interrupting', '');
    expect(action).toBe<CtrlCAction>('force-exit');
  });

  test('agent finishes -> idle again', () => {
    // After done event, status returns to idle
    const action = resolveCtrlCAction('idle', '');
    expect(action).toBe<CtrlCAction>('exit');
  });
});

// ---------------------------------------------------------------------------
// Integration: multi-line input composition + submit
// ---------------------------------------------------------------------------

describe('Integration: multi-line composition', () => {
  test('type, insert newlines, backspace, then check content', () => {
    let value = '';

    // Type "hello"
    value = insertText(value, 'hello');
    expect(value).toBe('hello');

    // Press Enter (insert newline)
    value = insertText(value, '\n');
    expect(value).toBe('hello\n');

    // Type "world"
    value = insertText(value, 'world');
    expect(value).toBe('hello\nworld');

    // Backspace removes 'd'
    value = handleBackspace(value);
    expect(value).toBe('hello\nworl');

    // Cursor position
    const pos = getCursorPosition(value);
    expect(pos).toEqual({ row: 1, col: 4 });
  });
});

// ---------------------------------------------------------------------------
// submitInput command readiness
// ---------------------------------------------------------------------------

describe('submitInput', () => {
  test('does not send slash commands to the agent while registry is loading', async () => {
    const promptCalls: string[] = [];
    const dispatched: unknown[] = [];

    await submitInput('/resume', {
      registryStatus: 'loading',
      registryError: null,
      registry: {
        executeCommand: async () => {
          throw new Error('should not execute');
        },
      },
      session: {
        abort: () => {},
        prompt: async (value: string) => {
          promptCalls.push(value);
        },
      },
      store: {
        addUserMessage: () => {
          throw new Error('should not add user message');
        },
        dispatch: (event: unknown) => {
          dispatched.push(event);
        },
      },
    });

    expect(promptCalls).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: 'error',
      error: expect.any(Error),
    });
  });

  test('does not send slash commands to the agent after registry failure', async () => {
    const promptCalls: string[] = [];
    const dispatched: any[] = [];

    await submitInput('/clear', {
      registryStatus: 'failed',
      registryError: 'setup exploded',
      registry: {
        executeCommand: async () => false,
      },
      session: {
        abort: () => {},
        prompt: async (value: string) => {
          promptCalls.push(value);
        },
      },
      store: {
        addUserMessage: () => {},
        dispatch: (event: any) => {
          dispatched.push(event);
        },
      },
    });

    expect(promptCalls).toEqual([]);
    expect(dispatched[0].error.message).toContain('setup exploded');
  });

  test('executes known slash commands once the registry is ready', async () => {
    const executed: string[] = [];
    const promptCalls: string[] = [];

    await submitInput('/clear now', {
      registryStatus: 'ready',
      registryError: null,
      registry: {
        executeCommand: async (name: string, args: string) => {
          executed.push(`${name}:${args}`);
          return true;
        },
      },
      session: {
        abort: () => {},
        prompt: async (value: string) => {
          promptCalls.push(value);
        },
      },
      store: {
        addUserMessage: () => {},
        dispatch: () => {},
      },
    });

    expect(executed).toEqual(['/clear:now']);
    expect(promptCalls).toEqual([]);
  });

  test('executes /steer as a command instead of prompting the agent', async () => {
    const executed: string[] = [];
    const promptCalls: string[] = [];
    const userMessages: string[] = [];

    await submitInput('/steer use current file only', {
      registryStatus: 'ready',
      registryError: null,
      registry: {
        executeCommand: async (name: string, args: string) => {
          executed.push(`${name}:${args}`);
          return true;
        },
      },
      session: {
        abort: () => {},
        prompt: async (value: string) => {
          promptCalls.push(value);
        },
      },
      store: {
        addUserMessage: (value: string) => {
          userMessages.push(value);
        },
        dispatch: () => {},
      },
    });

    expect(executed).toEqual(['/steer:use current file only']);
    expect(promptCalls).toEqual([]);
    expect(userMessages).toEqual([]);
  });

  test('executes /agent as a command instead of prompting the agent', async () => {
    const executed: string[] = [];
    const promptCalls: string[] = [];
    const userMessages: string[] = [];

    await submitInput('/agent reviewer', {
      registryStatus: 'ready',
      registryError: null,
      registry: {
        executeCommand: async (name: string, args: string) => {
          executed.push(`${name}:${args}`);
          return true;
        },
      },
      session: {
        abort: () => {},
        prompt: async (value: string) => {
          promptCalls.push(value);
        },
      },
      store: {
        addUserMessage: (value: string) => {
          userMessages.push(value);
        },
        dispatch: () => {},
      },
    });

    expect(executed).toEqual(['/agent:reviewer']);
    expect(promptCalls).toEqual([]);
    expect(userMessages).toEqual([]);
  });

  test('sends ordinary text to the agent while registry is loading', async () => {
    const promptCalls: string[] = [];
    const userMessages: string[] = [];

    await submitInput('hello', {
      registryStatus: 'loading',
      registryError: null,
      registry: {
        executeCommand: async () => false,
      },
      session: {
        abort: () => {},
        prompt: async (value: string) => {
          promptCalls.push(value);
        },
      },
      store: {
        addUserMessage: (value: string) => {
          userMessages.push(value);
        },
        dispatch: () => {},
      },
    });

    expect(userMessages).toEqual(['hello']);
    expect(promptCalls).toEqual(['hello']);
  });
});
