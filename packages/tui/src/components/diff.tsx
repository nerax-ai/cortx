import { Box, Text } from 'ink';

interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
}

function toLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

/**
 * Simple line-level diff using LCS (Longest Common Subsequence).
 * Returns an array of diff lines with add/remove/context markers.
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;

  if (m === 0 && n === 0) return [];

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'context', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', content: newLines[j - 1] });
      j--;
    } else if (i > 0) {
      result.unshift({ type: 'remove', content: oldLines[i - 1] });
      i--;
    }
  }

  return result;
}

export interface DiffViewProps {
  oldText: string;
  newText: string;
  maxLines?: number;
}

/**
 * Renders a colored diff view for terminal display.
 * Green for additions, red for deletions, dim for context.
 */
export function DiffView({ oldText, newText, maxLines = 50 }: DiffViewProps) {
  const diff = computeDiff(oldText, newText);

  if (diff.length === 0 || diff.every((l) => l.type === 'context')) {
    return <Text dimColor>No changes</Text>;
  }

  const additions = diff.filter((l) => l.type === 'add').length;
  const removals = diff.filter((l) => l.type === 'remove').length;
  const trimmed = trimContext(diff, 3);
  const displayLines = trimmed.slice(0, maxLines);
  const truncated = trimmed.length > maxLines;

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text dimColor>{`+${additions} -${removals}`}</Text>
      {displayLines.map((line, i) => (
        <DiffLineView key={i} line={line} />
      ))}
      {truncated && (
        <Text dimColor>{`... ${trimmed.length - maxLines} more lines`}</Text>
      )}
    </Box>
  );
}

function DiffLineView({ line }: { line: DiffLine }) {
  switch (line.type) {
    case 'add':
      return <Text color="green">{'+ '}{line.content}</Text>;
    case 'remove':
      return <Text color="red">{'- '}{line.content}</Text>;
    case 'context':
    default:
      return <Text dimColor>{'  '}{line.content}</Text>;
  }
}

/**
 * Trim context lines to show only N lines around changes.
 */
export function trimContext(diff: DiffLine[], contextLines: number): DiffLine[] {
  const keep = new Set<number>();
  const changeIndices = diff
    .map((l, i) => (l.type !== 'context' ? i : -1))
    .filter((i) => i >= 0);

  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(diff.length - 1, idx + contextLines);
    for (let i = start; i <= end; i++) {
      keep.add(i);
    }
  }

  return diff.filter((_, i) => keep.has(i));
}
