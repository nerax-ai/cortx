/**
 * AgentSpec picker overlay.
 *
 * Lists runtime-discovered AgentSpec assets with keyboard filtering.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TuiAgentSpecInfo } from '../runtime-session.js';

export function filterAgentSpecs(specs: TuiAgentSpecInfo[], filter: string): TuiAgentSpecInfo[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return specs;
  return specs.filter((spec) =>
    [
      spec.name,
      spec.relativePath,
      spec.path,
      spec.promptPreview,
      spec.toolMode,
      spec.approvalMode,
    ]
      .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle)),
  );
}

export function moveAgentSpecSelection(currentIndex: number, direction: 'up' | 'down', itemCount: number): number {
  if (itemCount === 0) return -1;
  if (direction === 'up') return currentIndex <= 0 ? itemCount - 1 : currentIndex - 1;
  return currentIndex >= itemCount - 1 ? 0 : currentIndex + 1;
}

export function truncateAgentSpecText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function agentSpecModeLabel(spec: TuiAgentSpecInfo): string {
  const modes = [spec.toolMode, spec.approvalMode].filter(Boolean);
  return modes.length > 0 ? modes.join(' / ') : 'default controls';
}

export function agentSpecVisibleWindow(
  itemCount: number,
  selectedIndex: number,
  maxRows = 10,
): { start: number; selected: number } {
  if (itemCount === 0) return { start: 0, selected: -1 };
  const safeIndex = Math.min(Math.max(0, selectedIndex), itemCount - 1);
  const rowCount = Math.max(1, maxRows);
  const start = safeIndex >= rowCount ? safeIndex - rowCount + 1 : 0;
  return { start, selected: safeIndex - start };
}

export interface AgentSpecPickerProps {
  specs: TuiAgentSpecInfo[];
  loading?: boolean;
  error?: string | null;
  onSelect: (spec: TuiAgentSpecInfo) => void;
  onClose: () => void;
}

export function AgentSpecPicker({
  specs,
  loading = false,
  error = null,
  onSelect,
  onClose,
}: AgentSpecPickerProps) {
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filtered = filterAgentSpecs(specs, filter);
  const safeIndex = filtered.length === 0 ? -1 : Math.min(Math.max(0, selectedIndex), filtered.length - 1);
  const listMaxRows = 10;
  const visibleWindow = agentSpecVisibleWindow(filtered.length, safeIndex, listMaxRows);
  const scrollStart = visibleWindow.start;
  const visibleSpecs = filtered.slice(scrollStart, scrollStart + listMaxRows);
  const visibleSelectedIndex = visibleWindow.selected;

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      if (!loading && !error && safeIndex >= 0) onSelect(filtered[safeIndex]);
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(moveAgentSpecSelection(safeIndex, 'up', filtered.length));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(moveAgentSpecSelection(safeIndex, 'down', filtered.length));
      return;
    }

    if (key.backspace || key.delete) {
      setFilter((prev) => prev.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setFilter((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text bold color="cyan">Launch Agent</Text>
      </Box>

      <Box marginTop={1}>
        <Text bold color="cyan">{'> '}</Text>
        <Text>{filter}</Text>
        <Text dimColor>_</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {loading ? (
          <Text dimColor>Loading AgentSpecs...</Text>
        ) : error ? (
          <Text color="red">{error}</Text>
        ) : visibleSpecs.length === 0 ? (
          <Text dimColor>No AgentSpecs found</Text>
        ) : (
          visibleSpecs.map((spec, index) => {
            const selected = index === visibleSelectedIndex;
            return (
              <Box key={spec.path} flexDirection="column">
                <Box>
                  <Text bold color={selected ? 'cyan' : undefined}>{selected ? '> ' : '  '}</Text>
                  <Text bold={selected} color={selected ? 'green' : undefined}>{spec.name}</Text>
                  <Text dimColor>{` - ${spec.relativePath}`}</Text>
                  <Text dimColor>{` (${agentSpecModeLabel(spec)})`}</Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text dimColor>{truncateAgentSpecText(spec.promptPreview, 96)}</Text>
                </Box>
              </Box>
            );
          })
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter= launch | Up/Down= navigate | Esc= close</Text>
      </Box>
    </Box>
  );
}
