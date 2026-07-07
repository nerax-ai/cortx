import { constants } from 'fs';
import { access } from 'fs/promises';
import type { Tool } from '@cortx/sdk';
import { isWorkspacePathError, readTextNoFollow, replaceTextNoFollow, resolveWorkspacePath } from './path-safety.js';

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

function lineNumberForIndex(index: number): number {
  return index + 1;
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
      oldLine: lineNumberForIndex(index),
      newLine: lineNumberForIndex(index),
      text: oldLines[index] ?? '',
    });
  }
  for (let index = oldChangeStart; index < oldChangeEnd; index++) {
    lines.push({
      kind: 'remove',
      oldLine: lineNumberForIndex(index),
      text: oldLines[index] ?? '',
    });
  }
  for (let index = newChangeStart; index < newChangeEnd; index++) {
    lines.push({
      kind: 'add',
      newLine: lineNumberForIndex(index),
      text: newLines[index] ?? '',
    });
  }
  for (let index = 0; index < afterContextCount; index++) {
    const oldIndex = oldChangeEnd + index;
    const newIndex = newChangeEnd + index;
    lines.push({
      kind: 'context',
      oldLine: lineNumberForIndex(oldIndex),
      newLine: lineNumberForIndex(newIndex),
      text: oldLines[oldIndex] ?? newLines[newIndex] ?? '',
    });
  }

  return {
    kind: 'file_edit',
    path,
    contextLines: DIFF_CONTEXT_LINES,
    oldStartLine: lineNumberForIndex(oldChangeStart),
    newStartLine: lineNumberForIndex(newChangeStart),
    removedLines: Math.max(0, oldChangeEnd - oldChangeStart),
    addedLines: Math.max(0, newChangeEnd - newChangeStart),
    lines,
  };
}

export function createEditTool(cwd: string): Tool {
  return {
    name: 'edit',
    description: 'Replace exact text in a file. oldText must match exactly.',
    sideEffects: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        oldText: { type: 'string', description: 'Exact text to find and replace' },
        newText: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    execute: async ({ path, oldText, newText }) => {
      if (typeof path !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string')
        return { success: false, error: 'path, oldText, and newText must be strings' };
      let abs: string;
      try {
        abs = await resolveWorkspacePath(cwd, path);
      } catch (error) {
        if (isWorkspacePathError(error)) return { success: false, error: error.message };
        throw error;
      }
      await access(abs, constants.R_OK | constants.W_OK);
      const content = await readTextNoFollow(abs);
      if (!content.includes(oldText)) return { success: false, error: `Text not found in ${path}` };
      const matchIndex = content.indexOf(oldText);
      if (matchIndex !== content.lastIndexOf(oldText)) {
        return { success: false, error: `Text is not unique in ${path}; provide a more specific oldText.` };
      }
      const updated = content.replace(oldText, newText);
      const details = buildFileEditDetails(path, content, updated);
      await replaceTextNoFollow(abs, updated);
      return { success: true, output: `Edited ${path}`, details };
    },
  };
}
