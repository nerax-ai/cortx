import { useSyncExternalStore, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { formatToolSummary } from '@cortx/sdk';
import type { TuiStore } from '../store.js';
import type { TuiState } from '../types/tui-state.js';
import { colors } from '../theme.js';

const selectToolCalls = (s: TuiState) => s.toolCalls;
const selectAgentSessions = (s: TuiState) => s.agentSessions;

export interface ToolRegionProps {
  store: TuiStore;
  collapsed?: boolean;
  onViewAgent?: (toolCallId: string) => void;
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
function toolStatusIcon(entry: { status: string; isError?: boolean }): { icon: string; color: string } {
  if (entry.status === 'pending') return { icon: '◷', color: colors.toolPending };
  if (entry.isError) return { icon: '✗', color: colors.toolError };
  return { icon: '✓', color: colors.toolSuccess };
}

export function ToolRegion({ store, collapsed = true, onViewAgent }: ToolRegionProps) {
  const toolCalls = useSyncExternalStore(
    useCallback(
      (listener) => store.select(selectToolCalls).subscribe(listener),
      [store],
    ),
    useCallback(() => store.select(selectToolCalls).get(), [store]),
  );

  const agentSessions = useSyncExternalStore(
    useCallback((listener) => store.select(selectAgentSessions).subscribe(listener), [store]),
    useCallback(() => store.select(selectAgentSessions).get(), [store]),
  );

  const status = useSyncExternalStore(
    useCallback((listener) => store.select((s: TuiState) => s.status).subscribe(listener), [store]),
    useCallback(() => store.select((s: TuiState) => s.status).get(), [store]),
  );

  useInput((input, key) => {
    if (!key.return || !onViewAgent || collapsed || status !== 'idle') return;
    for (const [id, entry] of toolCalls) {
      if (entry.toolName === 'agent' && entry.status === 'complete' && agentSessions.has(id)) {
        onViewAgent(id);
        return;
      }
    }
  });

  if (toolCalls.size === 0) return null;

  const entries = [...toolCalls.entries()];

  // Collapsed: show only the latest tool call summary
  if (collapsed) {
    const [, latestEntry] = entries[entries.length - 1];
    const { icon: statusIcon, color: statusColor } = toolStatusIcon(latestEntry);

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
        const { icon: statusIcon, color: statusColor } = toolStatusIcon(entry);
        const hasAgentSession = entry.toolName === 'agent' && agentSessions.has(id);

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
              {hasAgentSession && entry.status === 'complete' && (
                <Text color="cyan">{' [Enter] view'}</Text>
              )}
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
