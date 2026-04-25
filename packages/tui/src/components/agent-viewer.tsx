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
    case 'running': return { text: 'running', color: colors.toolPending };
    case 'completed': return { text: 'completed', color: colors.toolSuccess };
    case 'error': return { text: 'error', color: colors.toolError };
  }
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
  });

  if (!summary || !session) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No agent data available. Press Escape to return.</Text>
      </Box>
    );
  }

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
          <Text bold color="cyan">Agent:</Text>
          <Text> {summary.description}</Text>
        </Box>
        <Box>
          <Text dimColor>Status: </Text>
          <Text color={statusColor}>{statusText}</Text>
          <Text dimColor>{' | '}{elapsed}s | {session.iterations} iter | {session.toolCallCount} tools</Text>
          {summary.isBackground && <Text color="magenta"> [background]</Text>}
          <Text dimColor>{' | Esc to return'}</Text>
        </Box>
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
