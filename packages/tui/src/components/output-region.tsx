import { useSyncExternalStore, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { TuiStore } from '../store.js';

export interface OutputRegionProps {
  store: TuiStore;
  height?: number;
}

interface OutputLine {
  type: 'user' | 'assistant' | 'tool-header' | 'tool-result';
  text: string;
}

function formatToolSummary(toolName: string, input: unknown): string {
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (toolName === 'agent') {
      const prompt = String(parsed?.prompt ?? '').slice(0, 80);
      const desc = String(parsed?.description ?? '');
      return desc ? `${desc}: ${prompt}` : prompt;
    }
    if (toolName === 'bash') {
      return String(parsed?.command ?? '').slice(0, 100);
    }
    if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
      return String(parsed?.file_path ?? parsed?.path ?? '').slice(0, 100);
    }
    return '';
  } catch {
    return '';
  }
}

function flattenToLines(turns: { role: string; content: string; duration?: number }[], toolCalls: Map<string, { toolName: string; input: unknown; result?: unknown; isError?: boolean; status: string; progress?: string }>, currentText: string): OutputLine[] {
  const lines: OutputLine[] = [];

  for (const turn of turns) {
    const durationTag = turn.duration != null && turn.duration > 0.1 ? ` (${turn.duration.toFixed(1)}s)` : '';
    if (turn.role === 'tool') {
      for (const line of turn.content.split('\n')) {
        lines.push({ type: 'tool-result', text: line });
      }
    } else {
      const role = turn.role === 'user' ? 'user' as const : 'assistant' as const;
      const contentLines = turn.content.split('\n');
      for (let i = 0; i < contentLines.length; i++) {
        // Show duration on the last line of the turn
        const suffix = durationTag && i === contentLines.length - 1 ? durationTag : '';
        lines.push({ type: role, text: contentLines[i] + suffix });
      }
    }
  }

  for (const entry of toolCalls.values()) {
    const icon = entry.status === 'pending' ? '\u25F7' : entry.isError ? '\u2717' : '\u2713';
    const summary = formatToolSummary(entry.toolName, entry.input);
    lines.push({ type: 'tool-header', text: summary ? `${icon} ${entry.toolName}: ${summary}` : `${icon} ${entry.toolName}` });
    // Show progress text (e.g., sub-agent status)
    if (entry.progress) {
      lines.push({ type: 'tool-result', text: entry.progress });
    }
    if (entry.result !== undefined) {
      const resultStr = String(entry.result).length > 300 ? String(entry.result).slice(0, 300) + '...' : String(entry.result);
      for (const line of resultStr.split('\n')) {
        lines.push({ type: 'tool-result', text: line });
      }
    }
  }

  if (currentText) {
    for (const line of currentText.split('\n')) {
      lines.push({ type: 'assistant', text: line });
    }
  }

  return lines;
}

export function OutputRegion({ store, height }: OutputRegionProps) {
  const messages = useSyncExternalStore(
    useCallback((listener) => store.select((s) => s.messages).subscribe(listener), [store]),
    useCallback(() => store.select((s) => s.messages).get(), [store]),
  );

  const toolCalls = useSyncExternalStore(
    useCallback((listener) => store.select((s) => s.toolCalls).subscribe(listener), [store]),
    useCallback(() => store.select((s) => s.toolCalls).get(), [store]),
  );

  const scrollOffset = useSyncExternalStore(
    useCallback((listener) => store.select((s) => s.scrollOffset).subscribe(listener), [store]),
    useCallback(() => store.select((s) => s.scrollOffset).get(), [store]),
  );

  const autoFollow = useSyncExternalStore(
    useCallback((listener) => store.select((s) => s.autoFollow).subscribe(listener), [store]),
    useCallback(() => store.select((s) => s.autoFollow).get(), [store]),
  );

  const { turns, currentText } = messages;
  const allLines = useMemo(
    () => flattenToLines(turns, toolCalls, currentText),
    [turns, toolCalls, currentText],
  );

  const totalLines = allLines.length;
  const viewportHeight = height ?? 20;

  // When autoFollow, always show the bottom of content
  const effectiveOffset = autoFollow ? 0 : Math.min(scrollOffset, Math.max(0, totalLines - viewportHeight));
  const startIdx = Math.max(0, totalLines - viewportHeight - effectiveOffset);
  const endIdx = Math.min(totalLines, startIdx + viewportHeight);
  const visibleLines = allLines.slice(startIdx, endIdx);

  const showScrollIndicator = !autoFollow && totalLines > viewportHeight;

  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1} {...(height ? { height } : {})}>
      {totalLines === 0 ? (
        <Text dimColor>Waiting for output...</Text>
      ) : (
        <>
          {visibleLines.map((line, i) => {
            switch (line.type) {
              case 'user':
                return <Text key={`l-${i}`} color="cyan" bold>{'>'} {line.text}</Text>;
              case 'tool-header': {
                const isError = line.text.startsWith('\u2717');
                const isPending = line.text.startsWith('\u25F7');
                return <Text key={`l-${i}`} color={isPending ? 'yellow' : isError ? 'red' : 'green'} bold>{line.text}</Text>;
              }
              case 'tool-result':
                return <Text key={`l-${i}`} dimColor>{'  '}{line.text}</Text>;
              case 'assistant':
              default:
                return <Text key={`l-${i}`}>{line.text}</Text>;
            }
          })}
          {showScrollIndicator && (
            <Text dimColor color="yellow">-- More -- (PgUp/PgDn to scroll, Shift+G to bottom)</Text>
          )}
        </>
      )}
    </Box>
  );
}
