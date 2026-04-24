import { useSyncExternalStore, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { TuiStore } from '../store.js';
import { Markdown } from './markdown.js';
import { colors } from '../theme.js';

export interface OutputRegionProps {
  store: TuiStore;
  height?: number;
}

interface OutputBlock {
  type: 'user' | 'assistant' | 'thinking';
  content: string;
}

function buildBlocks(
  turns: { role: string; content: string; duration?: number }[],
  currentText: string,
  currentThinking: string,
): OutputBlock[] {
  const blocks: OutputBlock[] = [];

  for (const turn of turns) {
    if (turn.role === 'tool') {
      // Tool turns are displayed in ToolRegion, skip here
      continue;
    } else if (turn.role === 'user') {
      const durationTag = turn.duration != null && turn.duration > 0.1 ? ` (${turn.duration.toFixed(1)}s)` : '';
      blocks.push({ type: 'user', content: turn.content + durationTag });
    } else {
      const durationTag = turn.duration != null && turn.duration > 0.1 ? ` (${turn.duration.toFixed(1)}s)` : '';
      blocks.push({ type: 'assistant', content: turn.content + durationTag });
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
    () => buildBlocks(turns, currentText, currentThinking),
    [turns, currentText, currentThinking],
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
      return <Text color={colors.userMessage} bold>{'>'} {block.content}</Text>;

    case 'thinking':
      return (
        <Box>
          <Text dimColor color={colors.thinking}>{'▶'} Thinking...</Text>
        </Box>
      );

    case 'assistant':
    default:
      return <Markdown text={block.content} />;
  }
}
