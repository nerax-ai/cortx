import { useSyncExternalStore, useCallback } from 'react';
import { Box, Text } from 'ink';
import type { TuiStore } from '../store.js';
import { colors } from '../theme.js';

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
function formatToolSummary(toolName: string, input: unknown): string {
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (toolName === 'agent') {
      const prompt = String(parsed?.prompt ?? '').slice(0, 60);
      const desc = String(parsed?.description ?? '');
      return desc ? `${desc}: ${prompt}` : prompt;
    }
    if (toolName === 'bash') {
      return String(parsed?.command ?? '').slice(0, 80);
    }
    if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
      return String(parsed?.file_path ?? parsed?.path ?? '').slice(0, 80);
    }
    return '';
  } catch {
    return '';
  }
}

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
    const [, latestEntry] = entries[entries.length - 1];
    const statusIcon = latestEntry.status === 'pending'
      ? '\u25F7'  // ◷ running
      : latestEntry.isError
        ? '\u2717'  // ✗ error
        : '\u2713';  // ✓ done

    const statusColor = latestEntry.status === 'pending'
      ? colors.toolPending
      : latestEntry.isError
        ? colors.toolError
        : colors.toolSuccess;

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
          {(() => {
            const summary = formatToolSummary(latestEntry.toolName, latestEntry.input);
            return summary ? <Text dimColor>{': '}{summary}</Text> : null;
          })()}
          {totalCount > 1 && (
            <Text dimColor>
              {' '}
              ({pendingCount > 0 ? `${pendingCount}/${totalCount} running` : `${totalCount} tools`})
            </Text>
          )}
          <Text dimColor>{' [Shift+T] expand'}</Text>
        </Box>
      </Box>
    );
  }

  // Expanded: show all tool calls with details
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">Tool Calls</Text>
        <Text dimColor>{' [Shift+T] collapse'}</Text>
      </Box>
      {entries.map(([id, entry]) => {
        const statusIcon = entry.status === 'pending'
          ? '\u25F7'
          : entry.isError
            ? '\u2717'
            : '\u2713';

        const statusColor = entry.status === 'pending'
          ? colors.toolPending
          : entry.isError
            ? colors.toolError
            : colors.toolSuccess;

        return (
          <Box key={id} flexDirection="column" marginLeft={1}>
            <Text>
              <Text color={statusColor}>{statusIcon}</Text>
              {' '}
              <Text bold>{entry.toolName}</Text>
              {(() => {
                const summary = formatToolSummary(entry.toolName, entry.input);
                return summary ? <Text dimColor>{': '}{summary}</Text> : null;
              })()}
            </Text>
            {entry.result !== undefined && (() => {
              const resultStr = String(entry.result);
              // For edit/write tools with multi-line results, show a compact summary
              const isFileEdit = entry.toolName === 'write' || entry.toolName === 'edit';
              if (isFileEdit && resultStr.length > 100) {
                const lines = resultStr.split('\n').length;
                const addCount = (resultStr.match(/^\+/gm) || []).length;
                const rmCount = (resultStr.match(/^-/gm) || []).length;
                return (
                  <Box marginLeft={2}>
                    <Text dimColor>{lines} lines changed</Text>
                    <Text color="green">{` +${addCount}`}</Text>
                    <Text color="red">{` -${rmCount}`}</Text>
                  </Box>
                );
              }
              return (
                <Box marginLeft={2}>
                  <Text dimColor>
                    {resultStr.slice(0, 200)}
                    {resultStr.length > 200 ? '...' : ''}
                  </Text>
                </Box>
              );
            })()}
          </Box>
        );
      })}
    </Box>
  );
}
