const DIFF_CONTEXT_LINES = 3;

export interface FileDiffLine {
  kind: 'context' | 'remove' | 'add';
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface FileEditDetails {
  kind: 'file_edit';
  path: string;
  contextLines: number;
  oldStartLine: number;
  newStartLine: number;
  removedLines: number;
  addedLines: number;
  lines: FileDiffLine[];
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function displayLines(text: string): string[] {
  const lines = splitLines(text);
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function commonPrefixLength(left: string[], right: string[]): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index++;
  return index;
}

function commonSuffixLength(left: string[], right: string[], prefixLength: number): number {
  const max = Math.min(left.length, right.length) - prefixLength;
  let count = 0;
  while (count < max && left[left.length - 1 - count] === right[right.length - 1 - count]) count++;
  return count;
}

function lineNumber(index: number): number {
  return index + 1;
}

export function buildFileEditDetails(path: string, content: string, updated: string): FileEditDetails {
  const oldLines = displayLines(content);
  const newLines = displayLines(updated);
  const prefixLength = commonPrefixLength(oldLines, newLines);
  const suffixLength = commonSuffixLength(oldLines, newLines, prefixLength);
  const oldChangeStart = prefixLength;
  const newChangeStart = prefixLength;
  const oldChangeEnd = oldLines.length - suffixLength;
  const newChangeEnd = newLines.length - suffixLength;
  const beforeContextStart = Math.max(0, oldChangeStart - DIFF_CONTEXT_LINES);
  const afterContextCount = Math.min(
    DIFF_CONTEXT_LINES,
    oldLines.length - oldChangeEnd,
    newLines.length - newChangeEnd,
  );
  const lines: FileDiffLine[] = [];

  for (let index = beforeContextStart; index < oldChangeStart; index++) {
    lines.push({
      kind: 'context',
      oldLine: lineNumber(index),
      newLine: lineNumber(index),
      text: oldLines[index] ?? '',
    });
  }
  for (let index = oldChangeStart; index < oldChangeEnd; index++) {
    lines.push({ kind: 'remove', oldLine: lineNumber(index), text: oldLines[index] ?? '' });
  }
  for (let index = newChangeStart; index < newChangeEnd; index++) {
    lines.push({ kind: 'add', newLine: lineNumber(index), text: newLines[index] ?? '' });
  }
  for (let index = 0; index < afterContextCount; index++) {
    const oldIndex = oldChangeEnd + index;
    const newIndex = newChangeEnd + index;
    lines.push({
      kind: 'context',
      oldLine: lineNumber(oldIndex),
      newLine: lineNumber(newIndex),
      text: oldLines[oldIndex] ?? newLines[newIndex] ?? '',
    });
  }

  return {
    kind: 'file_edit',
    path,
    contextLines: DIFF_CONTEXT_LINES,
    oldStartLine: lineNumber(oldChangeStart),
    newStartLine: lineNumber(newChangeStart),
    removedLines: Math.max(0, oldChangeEnd - oldChangeStart),
    addedLines: Math.max(0, newChangeEnd - newChangeStart),
    lines,
  };
}
