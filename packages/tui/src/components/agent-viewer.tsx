import { useSyncExternalStore, useCallback, useEffect, useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TuiStore } from '../store.js';
import type { TuiState, AgentSessionSummary } from '../types/tui-state.js';
import type { SubAgentSession } from '@cortx/core';
import { colors } from '../theme.js';

const selectActiveAgentView = (s: TuiState) => s.activeAgentView;
const selectAgentSessions = (s: TuiState) => s.agentSessions;

export interface AgentViewerProps {
  store: TuiStore;
  agentSessionsStore: { get(id: string): SubAgentSession | undefined; subscribe(fn: () => void): () => void };
  onExit: () => void;
}

function statusLabel(status: SubAgentSession['status']): { text: string; color: string } {
  switch (status) {
    case 'running': return { text: 'working', color: colors.toolPending };
    case 'completed': return { text: 'done', color: colors.toolSuccess };
    case 'error': return { text: 'error', color: colors.toolError };
  }
}

export function agentSessionIds(agentSessions: ReadonlyMap<string, AgentSessionSummary>): string[] {
  return [...agentSessions.values()]
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.toolCallId.localeCompare(b.toolCallId))
    .map((session) => session.toolCallId);
}

export function adjacentAgentSessionId(
  ids: string[],
  currentId: string,
  direction: 'previous' | 'next',
): string | null {
  if (ids.length === 0) return null;
  const currentIndex = ids.indexOf(currentId);
  const startIndex = currentIndex === -1 ? 0 : currentIndex;
  const offset = direction === 'next' ? 1 : -1;
  return ids[(startIndex + offset + ids.length) % ids.length];
}

function statusRank(status: AgentSessionSummary['status']): number {
  if (status === 'running') return 0;
  if (status === 'error') return 1;
  return 2;
}

export function AgentViewer({ store, agentSessionsStore, onExit }: AgentViewerProps) {
  const activeAgentView = useSyncExternalStore(
    useCallback((listener) => store.select(selectActiveAgentView).subscribe(listener), [store]),
    useCallback(() => store.select(selectActiveAgentView).get(), [store]),
  );

  const agentSessions = useSyncExternalStore(
    useCallback((listener) => store.select(selectAgentSessions).subscribe(listener), [store]),
    useCallback(() => store.select(selectAgentSessions).get(), [store]),
  );

  const [, setTick] = useState(0);
  const forceUpdate = useCallback(() => setTick((t: number) => t + 1), []);
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const summary = activeAgentView ? agentSessions.get(activeAgentView) : undefined;
  const session = activeAgentView ? agentSessionsStore.get(activeAgentView) : undefined;
  const sessionIds = agentSessionIds(agentSessions);

  // Poll for updates when viewing a running agent
  useEffect(() => {
    if (session?.status === 'running') {
      tickRef.current = setInterval(forceUpdate, 200);
      const unsub = agentSessionsStore.subscribe(forceUpdate);
      return () => { clearInterval(tickRef.current); unsub(); };
    }
  }, [session?.status, agentSessionsStore]);

  useInput((input, key) => {
    if (key.escape) onExit();
    if (!activeAgentView) return;
    if (key.rightArrow || input === 'n') {
      const next = adjacentAgentSessionId(sessionIds, activeAgentView, 'next');
      if (next) store.setActiveAgentView(next);
    }
    if (key.leftArrow || input === 'p') {
      const previous = adjacentAgentSessionId(sessionIds, activeAgentView, 'previous');
      if (previous) store.setActiveAgentView(previous);
    }
  });

  if (!activeAgentView || !summary || !session) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No agent data available. Press Escape to return.</Text>
      </Box>
    );
  }

  const activeId = activeAgentView;
  const { text: statusText, color: statusColor } = statusLabel(summary.status);
  const elapsed = session.completedAt
    ? Math.round((session.completedAt - session.startedAt) / 1000)
    : Math.round((Date.now() - session.startedAt) / 1000);

  // Extract text and tool events from the session
  const textParts: string[] = [];
  const toolEntries: { toolCallId: string; toolName: string; summary: string; status: string; isError?: boolean }[] = [];

  for (const event of session.events) {
    if (event.type === 'text' && event.content) textParts.push(event.content);
    if (event.type === 'text_delta') textParts.push(event.delta);
    if (event.type === 'tool_use') {
      const summary = formatSubAgentToolSummary(event.toolCall.toolName, event.toolCall.input);
      toolEntries.push({ toolCallId: event.toolCall.toolCallId, toolName: event.toolCall.toolName, summary, status: 'pending' });
    }
    if (event.type === 'tool_result') {
      const entry = toolEntries.find(t => t.toolCallId === event.toolCallId);
      if (entry) {
        entry.status = 'complete';
        entry.isError = event.isError;
      }
    }
  }

  const fullText = textParts.join('');

  return (
    <Box flexDirection="column">
      {/* Header bar */}
      <Box paddingX={1} borderStyle="single" borderColor={colors.border} flexDirection="column">
        <Box>
          <Text bold color="cyan">Sub-agent</Text>
          <Text> {summary.description}</Text>
        </Box>
        <Box>
          <Text color={statusColor}>{statusText}</Text>
          <Text dimColor>{'  |  '}{elapsed}s  |  {session.iterations} iter  |  {session.toolCallCount} tools</Text>
          {summary.isBackground && <Text color="magenta"> [background]</Text>}
          {sessionIds.length > 1 && <Text dimColor>{'  |  '}agent {sessionIds.indexOf(activeId) + 1}/{sessionIds.length}</Text>}
          <Text dimColor>{'  |  Esc return'}</Text>
          {sessionIds.length > 1 && <Text dimColor>{'  |  Left/Right switch'}</Text>}
        </Box>
        {summary.progress && (
          <Box>
            <Text dimColor>Progress: </Text>
            <Text>{summary.progress}</Text>
          </Box>
        )}
      </Box>

      {/* Agent text output */}
      {fullText && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text>{fullText.slice(0, 2000)}</Text>
          {fullText.length > 2000 && <Text dimColor>... ({fullText.length} chars total)</Text>}
        </Box>
      )}

      {/* Agent tool calls */}
      {toolEntries.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text bold dimColor>Tool Calls:</Text>
          {toolEntries.map((entry, i) => {
            const { icon, color } = toolEntryIcon(entry);
            return (
              <Box key={i} marginLeft={1}>
                <Text color={color}>{icon}</Text>
                <Text>{' '}{entry.toolName}</Text>
                {entry.summary && <Text dimColor>{': '}{entry.summary}</Text>}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

function toolEntryIcon(entry: { status: string; isError?: boolean }): { icon: string; color: string } {
  if (entry.status === 'pending') return { icon: '◷', color: colors.toolPending };
  if (entry.isError) return { icon: '✗', color: colors.toolError };
  return { icon: '✓', color: colors.toolSuccess };
}

function formatSubAgentToolSummary(toolName: string, input: unknown): string {
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (toolName === 'bash') return String(parsed?.command ?? '').slice(0, 60);
    if (['read', 'write', 'edit'].includes(toolName)) return String(parsed?.file_path ?? parsed?.path ?? '').slice(0, 80);
    if (toolName === 'grep') return String(parsed?.pattern ?? '').slice(0, 40);
    return '';
  } catch {
    return '';
  }
}
