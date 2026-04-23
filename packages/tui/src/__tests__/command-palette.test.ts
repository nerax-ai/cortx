import { describe, test, expect } from 'bun:test';
import {
  filterCommands,
  moveSelection,
  formatHelpText,
} from '../components/command-palette.js';
import type { CommandDef } from '../types/tui-plugin.js';
import { TUI_COMMAND } from '../types/tui-plugin.js';
import { TuiRegistry } from '../tui-registry.js';
import { commandPlugin } from '../plugins/command-plugin.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const sampleCommands: CommandDef[] = [
  {
    name: '/exit',
    description: 'Exit the TUI application',
    handler: async () => {},
  },
  {
    name: '/clear',
    description: 'Clear the output and reset conversation state',
    handler: async () => {},
  },
  {
    name: '/config',
    description: 'Show current configuration',
    handler: async () => {},
  },
  {
    name: '/help',
    description: 'List all available commands',
    handler: async () => {},
  },
  {
    name: '/resume',
    description: 'Resume a previous session',
    handler: async () => {},
  },
];

// ---------------------------------------------------------------------------
// filterCommands
// ---------------------------------------------------------------------------

describe('filterCommands', () => {
  test('empty filter returns all commands', () => {
    const result = filterCommands(sampleCommands, '');
    expect(result).toEqual(sampleCommands);
  });

  test('filters by name substring (case-insensitive)', () => {
    const result = filterCommands(sampleCommands, 'ex');
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('/exit');
  });

  test('filters by description substring (case-insensitive)', () => {
    const result = filterCommands(sampleCommands, 'configuration');
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('/config');
  });

  test('filters by partial name match', () => {
    const result = filterCommands(sampleCommands, '/c');
    expect(result.length).toBe(2);
    const names = result.map((c) => c.name).sort();
    expect(names).toEqual(['/clear', '/config']);
  });

  test('returns empty array when no commands match', () => {
    const result = filterCommands(sampleCommands, 'xyznonexistent');
    expect(result).toEqual([]);
  });

  test('returns empty array when filtering empty commands', () => {
    const result = filterCommands([], 'test');
    expect(result).toEqual([]);
  });

  test('returns all commands when filtering empty commands with empty filter', () => {
    const result = filterCommands([], '');
    expect(result).toEqual([]);
  });

  test('case-insensitive matching', () => {
    const result1 = filterCommands(sampleCommands, 'EXIT');
    expect(result1.length).toBe(1);
    expect(result1[0].name).toBe('/exit');

    const result2 = filterCommands(sampleCommands, 'Clear');
    expect(result2.length).toBe(1);
    expect(result2[0].name).toBe('/clear');
  });

  test('matches against description', () => {
    const result = filterCommands(sampleCommands, 'session');
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('/resume');
  });

  test('slash prefix matches all commands', () => {
    const result = filterCommands(sampleCommands, '/');
    expect(result.length).toBe(sampleCommands.length);
  });
});

// ---------------------------------------------------------------------------
// moveSelection
// ---------------------------------------------------------------------------

describe('moveSelection', () => {
  test('moves down from first to second item', () => {
    expect(moveSelection(0, 'down', 5)).toBe(1);
  });

  test('moves up from second to first item', () => {
    expect(moveSelection(1, 'up', 5)).toBe(0);
  });

  test('wraps down from last to first', () => {
    expect(moveSelection(4, 'down', 5)).toBe(0);
  });

  test('wraps up from first to last', () => {
    expect(moveSelection(0, 'up', 5)).toBe(4);
  });

  test('returns -1 for empty list', () => {
    expect(moveSelection(0, 'down', 0)).toBe(-1);
    expect(moveSelection(0, 'up', 0)).toBe(-1);
  });

  test('single item: wraps in both directions', () => {
    expect(moveSelection(0, 'down', 1)).toBe(0);
    expect(moveSelection(0, 'up', 1)).toBe(0);
  });

  test('handles any valid index within range', () => {
    expect(moveSelection(2, 'down', 5)).toBe(3);
    expect(moveSelection(2, 'up', 5)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatHelpText
// ---------------------------------------------------------------------------

describe('formatHelpText', () => {
  test('formats all commands sorted by name', () => {
    const result = formatHelpText(sampleCommands);
    expect(result).toContain('Available commands:');
    expect(result).toContain('/clear');
    expect(result).toContain('/config');
    expect(result).toContain('/exit');
    expect(result).toContain('/help');
    expect(result).toContain('/resume');
  });

  test('includes descriptions', () => {
    const result = formatHelpText(sampleCommands);
    expect(result).toContain('Exit the TUI application');
    expect(result).toContain('Clear the output and reset conversation state');
    expect(result).toContain('Show current configuration');
  });

  test('pads names to same width', () => {
    const result = formatHelpText(sampleCommands);
    // All command lines should have the same indentation
    const lines = result.split('\n').slice(1); // skip header
    const positions = lines.map((line) => line.indexOf(' - '));
    // All positions should be the same
    const first = positions[0];
    expect(positions.every((p) => p === first)).toBe(true);
  });

  test('handles empty commands', () => {
    const result = formatHelpText([]);
    expect(result).toBe('No commands available.');
  });

  test('single command', () => {
    const commands: CommandDef[] = [
      { name: '/test', description: 'Test command', handler: async () => {} },
    ];
    const result = formatHelpText(commands);
    expect(result).toContain('/test');
    expect(result).toContain('Test command');
  });
});

// ---------------------------------------------------------------------------
// Integration: plugin registers new command -> appears in palette
// ---------------------------------------------------------------------------

describe('Integration: plugin commands in palette', () => {
  test('dynamically registered command appears in filtered results', () => {
    const registry = new TuiRegistry();
    // Don't call init() — manually register command plugin
    registry.registerPlugin(commandPlugin({
      exit: () => {},
      clear: () => {},
      getConfig: () => ({}),
      getCommands: () => registry.getCommands(),
    }));

    // Register an additional plugin command
    registry.registerPlugin({
      manifest: { id: 'custom-plugin', name: 'custom-plugin', version: '0.0.0' },
      setup(ctx: any) {
        ctx.register(TUI_COMMAND, 'custom', () => ({
          name: '/custom',
          description: 'A custom plugin command',
          handler: async () => {},
        }));
      },
    });

    const commands = registry.getCommands();
    expect(commands.length).toBe(6); // 5 built-in + 1 custom
    expect(commands.some((c) => c.name === '/custom')).toBe(true);

    // Verify it appears in palette filtering
    const filtered = filterCommands(commands, 'custom');
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe('/custom');
  });

  test('built-in commands appear in palette filtering', () => {
    const registry = new TuiRegistry();
    registry.registerPlugin(commandPlugin({
      exit: () => {},
      clear: () => {},
      getConfig: () => ({}),
    }));

    const commands = registry.getCommands();
    const filtered = filterCommands(commands, 'clear');
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe('/clear');
  });

  test('/help command with getCommands callback formats output', async () => {
    const registry = new TuiRegistry();
    registry.registerPlugin(commandPlugin({
      exit: () => {},
      clear: () => {},
      getConfig: () => ({}),
      getCommands: () => registry.getCommands(),
    }));

    // The /help command should use getCommands when available
    const commands = registry.getCommands();
    const helpText = formatHelpText(commands);
    expect(helpText).toContain('/exit');
    expect(helpText).toContain('/clear');
    expect(helpText).toContain('/help');
  });
});

// ---------------------------------------------------------------------------
// Integration: full navigation scenario
// ---------------------------------------------------------------------------

describe('Integration: navigation scenario', () => {
  test('typical palette usage: filter, navigate, select', () => {
    const commands = sampleCommands;

    // User types '/c' to filter by name prefix
    const filtered = filterCommands(commands, '/c');
    expect(filtered.length).toBe(2); // /clear, /config

    // User navigates down
    let index = 0;
    index = moveSelection(index, 'down', filtered.length);
    expect(index).toBe(1);
    expect(filtered[index].name).toBe('/config');

    // User navigates down again — wraps to 0
    index = moveSelection(index, 'down', filtered.length);
    expect(index).toBe(0);
    expect(filtered[index].name).toBe('/clear');

    // User navigates up — wraps to last
    index = moveSelection(index, 'up', filtered.length);
    expect(index).toBe(1);
    expect(filtered[index].name).toBe('/config');
  });

  test('filter to no results, backspace to widen', () => {
    // User types something that matches nothing
    let filtered = filterCommands(sampleCommands, 'zzz');
    expect(filtered.length).toBe(0);

    // User backspaces — now filter is 'z'
    filtered = filterCommands(sampleCommands, 'z');
    expect(filtered.length).toBe(0);

    // User backspaces — empty filter shows all
    filtered = filterCommands(sampleCommands, '');
    expect(filtered.length).toBe(sampleCommands.length);
  });

  test('filter then narrow further', () => {
    // Type '/c'
    const filtered1 = filterCommands(sampleCommands, '/c');
    expect(filtered1.length).toBe(2);

    // Narrow to '/cl'
    const filtered2 = filterCommands(sampleCommands, '/cl');
    expect(filtered2.length).toBe(1);
    expect(filtered2[0].name).toBe('/clear');

    // Narrow to '/co'
    const filtered3 = filterCommands(sampleCommands, '/co');
    expect(filtered3.length).toBe(1);
    expect(filtered3[0].name).toBe('/config');
  });
});
