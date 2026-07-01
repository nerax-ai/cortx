import { useSyncExternalStore, useCallback } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { formatToolSummary } from '@cortx/sdk';
import type { TuiStore } from '../store.js';
import type { AgentSessionSummary, TuiState, ToolCallEntry } from '../types/tui-state.js';
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

export function toolStats(toolCalls: ReadonlyMap<string, ToolCallEntry>): {
  total: number;
  running: number;
  failed: number;
  completed: number;
} {
  let running = 0;
  let failed = 0;
  let completed = 0;
  for (const entry of toolCalls.values()) {
    if (entry.status === 'pending') running += 1;
    else if (entry.isError) failed += 1;
    else completed += 1;
  }
  return { total: toolCalls.size, running, failed, completed };
}

export function formatToolStats(stats: ReturnType<typeof toolStats>): string {
  const parts: string[] = [];
  if (stats.running > 0) parts.push(`${stats.running} running`);
  if (stats.failed > 0) parts.push(`${stats.failed} failed`);
  if (stats.completed > 0) parts.push(`${stats.completed} done`);
  return parts.length > 0 ? parts.join(', ') : 'no tools';
}

export function visibleToolEntries<T>(entries: T[], maxEntries: number): { entries: T[]; hiddenCount: number } {
  if (entries.length <= maxEntries) return { entries, hiddenCount: 0 };
  return {
    entries: entries.slice(entries.length - maxEntries),
    hiddenCount: entries.length - maxEntries,
  };
}

export function firstViewableAgentToolCallId(
  toolCalls: ReadonlyMap<string, ToolCallEntry>,
  agentSessions: ReadonlyMap<string, AgentSessionSummary>,
): string | null {
  for (const [id, entry] of toolCalls) {
    if (entry.toolName === 'agent' && agentSessions.has(id)) return id;
  }
  return null;
}

export function ToolRegion({ store, collapsed = true, onViewAgent }: ToolRegionProps) {
  const { rows } = useWindowSize();
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
    const id = firstViewableAgentToolCallId(toolCalls, agentSessions);
    if (id) onViewAgent(id);
  });

  if (toolCalls.size === 0) return null;

  const entries = [...toolCalls.entries()];

  // Collapsed: show only the latest tool call summary
  if (collapsed) {
    const [, latestEntry] = entries[entries.length - 1];
    const { icon: statusIcon, color: statusColor } = toolStatusIcon(latestEntry);

    const stats = toolStats(toolCalls);

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
          {stats.total > 1 && (
            <Text dimColor>
              {' '}
              ({formatToolStats(stats)})
            </Text>
          )}
          <Text dimColor>{' [Shift+T] expand'}</Text>
        </Box>
      </Box>
    );
  }

  const maxExpandedEntries = Math.max(2, Math.min(6, Math.floor(rows / 5)));
  const expanded = visibleToolEntries(entries, maxExpandedEntries);

  // Expanded: show recent tool calls with details
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">Tool Calls</Text>
        <Text dimColor>{'  '}{formatToolStats(toolStats(toolCalls))}</Text>
        <Text dimColor>{' [Shift+T] collapse'}</Text>
      </Box>
      {expanded.hiddenCount > 0 && (
        <Box marginLeft={1}>
          <Text dimColor>{`... ${expanded.hiddenCount} earlier tool call${expanded.hiddenCount === 1 ? '' : 's'} hidden`}</Text>
        </Box>
      )}
      {expanded.entries.map(([id, entry]) => {
        const { icon: statusIcon, color: statusColor } = toolStatusIcon(entry);
        const agentSession = entry.toolName === 'agent' ? agentSessions.get(id) : undefined;

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
              {agentSession && (
                <Text color="cyan">{` [Enter] view ${agentSession.status}`}</Text>
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
