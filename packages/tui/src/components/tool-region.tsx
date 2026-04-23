import { useSyncExternalStore, useCallback } from 'react';
import { Box, Text } from 'ink';
import type { TuiStore } from '../store.js';

export interface ToolRegionProps {
  store: TuiStore;
  collapsed?: boolean;
}

/**
 * Tool region - displays tool call/result pairs.
 * Subscribes to the toolCalls state slice via useSyncExternalStore.
 * Selective redraw: only re-renders when the toolCalls slice changes.
 *
 * Collapsible behavior:
 *   - collapsed (default): shows only the latest tool call summary
 *   - expanded: shows all tool calls with input/result details
 *   - Toggle with 't' key when agent is idle
 */
export function ToolRegion({ store, collapsed = true }: ToolRegionProps) {
  const toolCalls = useSyncExternalStore(
    useCallback(
      (listener) => store.select((s) => s.toolCalls).subscribe(listener),
      [store],
    ),
    useCallback(() => store.select((s) => s.toolCalls).get(), [store]),
  );

  if (toolCalls.size === 0) return null;

  const entries = [...toolCalls.entries()];

  // Collapsed: show only the latest tool call summary
  if (collapsed) {
    const [latestId, latestEntry] = entries[entries.length - 1];
    const statusIcon = latestEntry.status === 'pending'
      ? '\u25F7'  // ◷ running
      : latestEntry.isError
        ? '\u2717'  // ✗ error
        : '\u2713';  // ✓ done

    const statusColor = latestEntry.status === 'pending'
      ? 'yellow'
      : latestEntry.isError
        ? 'red'
        : 'green';

    const pendingCount = entries.filter(([, e]) => e.status === 'pending').length;
    const totalCount = entries.length;

    return (
      <Box paddingX={1} flexDirection="column">
        <Box>
          <Text>
            <Text color={statusColor}>{statusIcon}</Text>
            {' '}
            <Text bold>{latestEntry.toolName}</Text>
          </Text>
          {totalCount > 1 && (
            <Text dimColor>
              {' '}
              ({pendingCount > 0 ? `${pendingCount}/${totalCount} running` : `${totalCount} tools`})
            </Text>
          )}
          <Text dimColor>{' [t] expand'}</Text>
        </Box>
      </Box>
    );
  }

  // Expanded: show all tool calls with details
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">Tool Calls</Text>
        <Text dimColor>{' [t] collapse'}</Text>
      </Box>
      {entries.map(([id, entry]) => {
        const statusIcon = entry.status === 'pending'
          ? '\u25F7'
          : entry.isError
            ? '\u2717'
            : '\u2713';

        const statusColor = entry.status === 'pending'
          ? 'yellow'
          : entry.isError
            ? 'red'
            : 'green';

        return (
          <Box key={id} flexDirection="column" marginLeft={1}>
            <Text>
              <Text color={statusColor}>{statusIcon}</Text>
              {' '}
              <Text bold>{entry.toolName}</Text>
            </Text>
            {entry.result !== undefined && (
              <Box marginLeft={2}>
                <Text dimColor>
                  {String(entry.result).slice(0, 200)}
                  {String(entry.result).length > 200 ? '...' : ''}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
