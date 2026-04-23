/**
 * Command palette overlay — pure display component.
 *
 * Input handling lives in InputArea. This component receives the filter
 * text and selected index as props and renders the filtered list.
 */

import { Box, Text } from 'ink';
import type { CommandDef } from '../types/tui-plugin.js';
import type { SkillItem } from '../plugins/skill-plugin.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

export interface PaletteItem {
  name: string;
  description: string;
  type: 'command' | 'skill';
}

export function buildItems(commands: CommandDef[], skills: SkillItem[]): PaletteItem[] {
  const cmds: PaletteItem[] = commands.map((c) => ({
    name: c.name,
    description: c.description,
    type: 'command' as const,
  }));
  const sks: PaletteItem[] = skills.map((s) => ({
    name: `/${s.name}`,
    description: s.description,
    type: 'skill' as const,
  }));
  return [...cmds, ...sks];
}

export function filterItems(items: PaletteItem[], filter: string): PaletteItem[] {
  if (!filter) return items;
  const lower = filter.toLowerCase();
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(lower) ||
      item.description.toLowerCase().includes(lower),
  );
}

/** Backward-compatible filter for CommandDef arrays (used by tests). */
export function filterCommands(commands: CommandDef[], filter: string): CommandDef[] {
  if (!filter) return commands;
  const lower = filter.toLowerCase();
  return commands.filter(
    (c) =>
      c.name.toLowerCase().includes(lower) ||
      c.description.toLowerCase().includes(lower),
  );
}

export function moveSelection(
  currentIndex: number,
  direction: 'up' | 'down',
  itemCount: number,
): number {
  if (itemCount === 0) return -1;
  if (direction === 'up') {
    return currentIndex <= 0 ? itemCount - 1 : currentIndex - 1;
  } else {
    return currentIndex >= itemCount - 1 ? 0 : currentIndex + 1;
  }
}

export function formatHelpText(commands: CommandDef[]): string {
  if (commands.length === 0) return 'No commands available.';

  const maxNameLen = Math.max(...commands.map((c) => c.name.length));
  const lines = commands
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cmd) => `  ${cmd.name.padEnd(maxNameLen)}  - ${cmd.description}`);

  return ['Available commands:', ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface CommandPaletteProps {
  items: PaletteItem[];
  filter: string;
  selectedIndex: number;
  maxHeight?: number;
}

// ---------------------------------------------------------------------------
// Component (display only — no input handling)
// ---------------------------------------------------------------------------

export function CommandPalette({
  items,
  filter,
  selectedIndex,
  maxHeight,
}: CommandPaletteProps) {
  const filtered = filterItems(items, filter);

  const safeIndex =
    filtered.length === 0
      ? -1
      : Math.min(selectedIndex, filtered.length - 1);

  const absoluteMax = maxHeight ? Math.max(3, maxHeight - 3) : 20;
  const listMaxRows = Math.min(8, absoluteMax);
  const scrollStart = safeIndex >= listMaxRows ? safeIndex - listMaxRows + 1 : 0;
  const visibleItems = filtered.slice(scrollStart, scrollStart + listMaxRows);
  const visibleSelectedIndex = safeIndex - scrollStart;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box flexDirection="column">
        {visibleItems.length === 0 ? (
          <Text dimColor>No matches found</Text>
        ) : (
          visibleItems.map((item, i) => (
            <Box key={item.name}>
              {i === visibleSelectedIndex ? (
                <Text bold color="cyan">
                  {'> '}
                </Text>
              ) : (
                <Text>{'  '}</Text>
              )}
              <Text
                bold={i === visibleSelectedIndex}
                color={i === visibleSelectedIndex ? 'green' : undefined}
              >
                {item.name}
              </Text>
              {item.type === 'skill' && (
                <Text dimColor color="magenta"> [skill]</Text>
              )}
              <Text dimColor>{` - ${item.description}`}</Text>
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Enter= select | Up/Down= navigate | Esc= close
        </Text>
      </Box>
    </Box>
  );
}
