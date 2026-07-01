import { useSyncExternalStore, useCallback } from 'react';
import { Box, Text } from 'ink';
import type { TuiStore } from '../store.js';
import type { TuiState, TurnEntry } from '../types/tui-state.js';
import { parseMarkdown } from './markdown.js';
import { colors } from '../theme.js';

const selectMessages = (s: TuiState) => s.messages;
const selectStatus = (s: TuiState) => s.status;

export interface OutputRegionProps {
  store: TuiStore;
}

export function shouldShowThinking(currentThinking: string, currentText: string): boolean {
  return currentThinking.trim().length > 0 && currentText.trim().length === 0;
}

export function compactToolContent(content: string, maxLines = 3): string[] {
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `... ${lines.length - maxLines} more lines`];
}

export interface OutputLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

function markdownLines(text: string): string[] {
  const lines: string[] = [];
  for (const block of parseMarkdown(text)) {
    switch (block.type) {
      case 'heading':
        lines.push(block.text);
        break;
      case 'code_block':
        if (block.language) lines.push(`\`\`\` ${block.language}`);
        lines.push(...block.code.split('\n').map((line) => `  ${line}`));
        if (block.language) lines.push('```');
        break;
      case 'unclosed_fence':
        lines.push(block.fence);
        if (block.content) lines.push(...block.content.split('\n'));
        break;
      case 'paragraph':
        lines.push(...block.text.split('\n'));
        break;
      case 'thematic_break':
        lines.push('─'.repeat(40));
        break;
      case 'unordered_list':
        lines.push(...block.items.map((item) => `  • ${item}`));
        break;
      case 'ordered_list':
        lines.push(...block.items.map((item, index) => `  ${block.startNumber + index}. ${item}`));
        break;
      case 'blockquote':
        lines.push(...block.text.split('\n').map((line) => `│ ${line}`));
        break;
    }
  }
  return lines;
}

function labelForRole(role: string): { label: string; color: string | undefined } {
  if (role === 'user') return { label: 'you', color: colors.userMessage };
  if (role === 'tool') return { label: 'tool', color: colors.muted };
  return { label: 'cortx', color: colors.prompt };
}

export function turnToLines(turn: TurnEntry): OutputLine[] {
  const label = labelForRole(turn.role);
  const duration = turn.duration && turn.duration > 0.1 ? ` ${turn.duration.toFixed(1)}s` : '';
  const lines: OutputLine[] = [{ text: `${label.label}${duration}`, color: label.color, bold: true }];

  if (turn.role === 'tool') {
    lines.push(...compactToolContent(turn.content).map((line) => ({ text: `  ${line}`, dim: true })));
    return lines;
  }

  const contentLines = turn.role === 'assistant' ? markdownLines(turn.content) : turn.content.split('\n');
  lines.push(...contentLines.map((line) => ({ text: `  ${line}` })));
  return lines;
}

export function buildOutputLines(input: {
  turns: TurnEntry[];
  showThinking: boolean;
  currentText: string;
}): OutputLine[] {
  const lines: OutputLine[] = [];
  for (const turn of input.turns) {
    if (lines.length > 0) lines.push({ text: '' });
    lines.push(...turnToLines(turn));
  }
  if (input.showThinking) {
    if (lines.length > 0) lines.push({ text: '' });
    lines.push({ text: '  thinking...', color: colors.thinking, dim: true });
  }
  if (input.currentText) {
    if (lines.length > 0) lines.push({ text: '' });
    lines.push({ text: 'cortx', color: colors.prompt, bold: true });
    lines.push(...markdownLines(input.currentText).map((line) => ({ text: `  ${line}` })));
  }
  return lines;
}

export function OutputRegion({ store }: OutputRegionProps) {
  const messages = useSyncExternalStore(
    useCallback((listener) => store.select(selectMessages).subscribe(listener), [store]),
    useCallback(() => store.select(selectMessages).get(), [store]),
  );
  const status = useSyncExternalStore(
    useCallback((listener) => store.select(selectStatus).subscribe(listener), [store]),
    useCallback(() => store.select(selectStatus).get(), [store]),
  );
  const showThinking = shouldShowThinking(messages.currentThinking, messages.currentText);
  const hasContent = messages.turns.length > 0 || showThinking || messages.currentText || status === 'running';

  if (!hasContent) {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>Start a conversation below.</Text>
      </Box>
    );
  }

  const allLines = buildOutputLines({
    turns: messages.turns,
    showThinking,
    currentText: messages.currentText,
  });

  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      {allLines.map((line, index) => (
        <Text key={index} color={line.color} dimColor={line.dim} bold={line.bold}>
          {line.text || ' '}
        </Text>
      ))}
    </Box>
  );
}
