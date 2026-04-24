import { useSyncExternalStore, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { TuiStore } from '../store.js';
import { Markdown } from './markdown.js';

export interface OutputRegionProps {
  store: TuiStore;
  height?: number;
}

interface OutputBlock {
  type: 'user' | 'assistant' | 'thinking' | 'tool-header' | 'tool-result';
  content: string;
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

function buildBlocks(
  turns: { role: string; content: string; duration?: number }[],
  toolCalls: Map<string, { toolName: string; input: unknown; result?: unknown; isError?: boolean; status: string; progress?: string }>,
  currentText: string,
  currentThinking: string,
): OutputBlock[] {
  const blocks: OutputBlock[] = [];

  for (const turn of turns) {
    if (turn.role === 'tool') {
      blocks.push({ type: 'tool-result', content: turn.content });
    } else if (turn.role === 'user') {
      const durationTag = turn.duration != null && turn.duration > 0.1 ? ` (${turn.duration.toFixed(1)}s)` : '';
      blocks.push({ type: 'user', content: turn.content + durationTag });
    } else {
      const durationTag = turn.duration != null && turn.duration > 0.1 ? ` (${turn.duration.toFixed(1)}s)` : '';
      blocks.push({ type: 'assistant', content: turn.content + durationTag });
    }
  }

  for (const entry of toolCalls.values()) {
    const icon = entry.status === 'pending' ? '◷' : entry.isError ? '✗' : '✓';
    const summary = formatToolSummary(entry.toolName, entry.input);
    blocks.push({ type: 'tool-header', content: summary ? `${icon} ${entry.toolName}: ${summary}` : `${icon} ${entry.toolName}` });
    if (entry.progress) {
      blocks.push({ type: 'tool-result', content: entry.progress });
    }
    if (entry.result !== undefined) {
      const resultStr = String(entry.result).length > 300 ? String(entry.result).slice(0, 300) + '...' : String(entry.result);
      blocks.push({ type: 'tool-result', content: resultStr });
    }
  }

  if (currentThinking) {
    blocks.push({ type: 'thinking', content: currentThinking });
  }

  if (currentText) {
    blocks.push({ type: 'assistant', content: currentText });
  }

  return blocks;
}

function estimateBlockHeight(block: OutputBlock): number {
  if (block.type === 'assistant') {
    // Markdown content can be taller due to code blocks, headings, etc.
    // Add extra lines for code blocks (```) and headings
    let height = 0;
    const lines = block.content.split('\n');
    let inCodeBlock = false;
    for (const line of lines) {
      if (line.trimStart().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        height += 1; // fence line
      } else {
        height += 1;
      }
    }
    // Add a small margin for markdown formatting
    return height + (inCodeBlock ? 1 : 0);
  }
  if (block.type === 'thinking') {
    return 1; // collapsed by default
  }
  return block.content.split('\n').length;
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

  const { turns, currentText, currentThinking } = messages;
  const blocks = useMemo(
    () => buildBlocks(turns, toolCalls, currentText, currentThinking),
    [turns, toolCalls, currentText, currentThinking],
  );

  // Compute cumulative heights for scroll calculation
  const blockHeights = useMemo(() => blocks.map(estimateBlockHeight), [blocks]);
  const totalHeight = blockHeights.reduce((sum, h) => sum + h, 0);
  const viewportHeight = height ?? 20;

  // Calculate visible blocks based on scroll offset
  const effectiveOffset = autoFollow ? 0 : Math.min(scrollOffset, Math.max(0, totalHeight - viewportHeight));
  const visibleBlocks: { block: OutputBlock; index: number }[] = [];
  let currentHeight = 0;
  let started = false;

  // Walk backwards from end to find where to start rendering
  const endOffset = totalHeight - effectiveOffset;
  const startOffset = Math.max(0, endOffset - viewportHeight);

  for (let i = 0; i < blocks.length; i++) {
    const bh = blockHeights[i];
    if (currentHeight + bh > startOffset && !started) {
      started = true;
    }
    if (started && currentHeight < endOffset) {
      visibleBlocks.push({ block: blocks[i], index: i });
    }
    currentHeight += bh;
    if (currentHeight >= endOffset) break;
  }

  const showScrollIndicator = !autoFollow && totalHeight > viewportHeight;

  if (blocks.length === 0) return null;

  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1} {...(height ? { height } : {})}>
      {visibleBlocks.map(({ block, index }) => (
        <BlockRenderer key={`b-${index}`} block={block} />
      ))}
      {showScrollIndicator && (
        <Text dimColor color="yellow">-- More -- (PgUp/PgDn to scroll, Shift+G to bottom)</Text>
      )}
    </Box>
  );
}

function BlockRenderer({ block }: { block: OutputBlock }) {
  switch (block.type) {
    case 'user':
      return <Text color="cyan" bold>{'>'} {block.content}</Text>;

    case 'thinking':
      return (
        <Box>
          <Text dimColor color="yellow">{'▶'} Thinking...</Text>
        </Box>
      );

    case 'assistant':
      return <Markdown text={block.content} />;

    case 'tool-header': {
      const isError = block.content.startsWith('✗');
      const isPending = block.content.startsWith('◷');
      return <Text color={isPending ? 'yellow' : isError ? 'red' : 'green'} bold>{block.content}</Text>;
    }

    case 'tool-result':
    default:
      return <Text dimColor>{'  '}{block.content}</Text>;
  }
}
