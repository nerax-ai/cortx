import { useSyncExternalStore, useCallback } from 'react';
import { Box, Text } from 'ink';
import type { TuiStore } from '../store.js';
import type { TuiState, TokenUsage, TuiStatus } from '../types/tui-state.js';
import { colors } from '../theme.js';

const selectSessionId = (s: TuiState) => s.sessionId;
const selectStatus = (s: TuiState) => s.status;
const selectIteration = (s: TuiState) => s.iteration;
const selectTokenUsage = (s: TuiState) => s.tokenUsage;
const selectTotalElapsed = (s: TuiState) => s.totalElapsed;

export interface SessionHeaderProps {
  store: TuiStore;
  model: string;
  cwd: string;
  registryReady?: boolean;
}

export function shortSessionId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}

export function compactPath(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  if (parts.length === 1) return parts[0];
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function formatTokenUsage(tokenUsage: TokenUsage): string {
  const format = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
  return `${format(tokenUsage.inputTokens)} in / ${format(tokenUsage.outputTokens)} out`;
}

export function statusBadge(status: TuiStatus, registryReady?: boolean): { label: string; color: string } {
  if (!registryReady) return { label: 'loading', color: colors.toolPending };
  switch (status) {
    case 'running':
      return { label: 'working', color: colors.activityExecuting };
    case 'interrupting':
      return { label: 'interrupting', color: colors.activityInterrupt };
    case 'awaiting_user':
      return { label: 'needs input', color: colors.activityThinking };
    case 'error':
      return { label: 'error', color: colors.activityError };
    default:
      return { label: 'ready', color: colors.activityIdle };
  }
}

export function headerSegments({
  model,
  cwd,
  sessionId,
  iteration,
  tokenUsage,
  totalElapsed,
}: {
  model: string;
  cwd: string;
  sessionId: string;
  iteration: number;
  tokenUsage: TokenUsage;
  totalElapsed: number;
}): string[] {
  const segments = [
    model,
    compactPath(cwd),
    `session ${shortSessionId(sessionId)}`,
  ];
  if (iteration > 0) segments.push(`turn ${iteration}`);
  if (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0) {
    segments.push(formatTokenUsage(tokenUsage));
  }
  if (totalElapsed > 0) segments.push(`${totalElapsed}s`);
  return segments;
}

export function SessionHeader({ store, model, cwd, registryReady = true }: SessionHeaderProps) {
  const sessionId = useSyncExternalStore(
    useCallback((listener) => store.select(selectSessionId).subscribe(listener), [store]),
    useCallback(() => store.select(selectSessionId).get(), [store]),
  );
  const tuiStatus = useSyncExternalStore(
    useCallback((listener) => store.select(selectStatus).subscribe(listener), [store]),
    useCallback(() => store.select(selectStatus).get(), [store]),
  );
  const iteration = useSyncExternalStore(
    useCallback((listener) => store.select(selectIteration).subscribe(listener), [store]),
    useCallback(() => store.select(selectIteration).get(), [store]),
  );
  const tokenUsage = useSyncExternalStore(
    useCallback((listener) => store.select(selectTokenUsage).subscribe(listener), [store]),
    useCallback(() => store.select(selectTokenUsage).get(), [store]),
  );
  const totalElapsed = useSyncExternalStore(
    useCallback((listener) => store.select(selectTotalElapsed).subscribe(listener), [store]),
    useCallback(() => store.select(selectTotalElapsed).get(), [store]),
  );
  const status = statusBadge(tuiStatus, registryReady);
  const segments = headerSegments({ model, cwd, sessionId, iteration, tokenUsage, totalElapsed });

  return (
    <Box paddingX={1} paddingY={0} flexDirection="column">
      <Box>
        <Text bold color="cyan">Cortx</Text>
        <Text dimColor>{' · '}</Text>
        <Text color={status.color} bold>{status.label}</Text>
      </Box>
      <Box>
        <Text dimColor>{segments.join('  ·  ')}</Text>
      </Box>
    </Box>
  );
}
