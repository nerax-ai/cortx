import { useSyncExternalStore, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { TuiStore } from '../store.js';
import type { TuiState } from '../types/tui-state.js';
import { Markdown } from './markdown.js';
import { colors } from '../theme.js';

const selectMessages = (s: TuiState) => s.messages;

export interface OutputRegionProps {
  store: TuiStore;
  height?: number;
}

interface OutputBlock {
  type: 'user' | 'assistant' | 'thinking' | 'tool';
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
      blocks.push({ type: 'tool', content: turn.content });
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

export function OutputRegion({ store, height }: OutputRegionProps) {
  const messages = useSyncExternalStore(
    useCallback((listener) => store.select(selectMessages).subscribe(listener), [store]),
    useCallback(() => store.select(selectMessages).get(), [store]),
  );

  const { turns, currentText, currentThinking } = messages;
  const blocks = useMemo(
    () => buildBlocks(turns, currentText, currentThinking),
    [turns, currentText, currentThinking],
  );

  if (blocks.length === 0) return null;

  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1} {...(height ? { height } : {})}>
      {blocks.map((block, index) => (
        <BlockRenderer key={`block-${index}`} block={block} />
      ))}
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

    case 'tool':
      return (
        <Box flexDirection="column" marginLeft={1}>
          {block.content.split('\n').map((line, i) => {
            if (line.startsWith('✓') || line.startsWith('✅')) {
              return <Text key={i} color={colors.toolSuccess}>{line}</Text>;
            }
            if (line.startsWith('✗') || line.startsWith('⏳')) {
              return <Text key={i} color={line.startsWith('✗') ? colors.toolError : colors.toolPending}>{line}</Text>;
            }
            if (line.startsWith('  ') || line.startsWith('│') || line.startsWith('╭') || line.startsWith('╰')) {
              return <Text key={i} dimColor>{line}</Text>;
            }
            return <Text key={i} dimColor>{line}</Text>;
          })}
        </Box>
      );

    case 'assistant':
    default:
      return <Markdown text={block.content} />;
  }
}
