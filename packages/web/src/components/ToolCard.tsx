import { useEffect, useState, type ReactNode } from 'react';
import { Collapsible } from '@base-ui-components/react/collapsible';
import type { ToolCallEntry } from '@cortx/store';
import { surface, truncateMiddle } from '../design';

interface ToolCardProps {
  entry: ToolCallEntry;
}

type FileToolKind = 'read' | 'write' | 'edit';

interface FileToolView {
  kind: FileToolKind;
  path: string;
  summary: string;
  meta?: string;
  body: ReactNode;
}

interface EditDiffLine {
  kind: 'context' | 'remove' | 'add';
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface EditDiffDetails {
  kind: 'file_edit';
  path: string;
  contextLines?: number;
  oldStartLine?: number;
  newStartLine?: number;
  removedLines?: number;
  addedLines?: number;
  source?: 'file_context' | 'input';
  lines: EditDiffLine[];
}

interface LineRange {
  start: number;
  end: number;
}

function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function plainText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const output = record.output ?? record.error ?? record.result;
    if (typeof output === 'string') return output;
  }
  return formatValue(value);
}

function inputRecord(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== 'string') return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function editDiffDetails(value: unknown): EditDiffDetails | null {
  const record = recordValue(value);
  if (!record || record.kind !== 'file_edit' || typeof record.path !== 'string' || !Array.isArray(record.lines)) return null;
  const lines: EditDiffLine[] = [];
  for (const line of record.lines) {
    const item = recordValue(line);
    if (!item) return null;
    const kind = item.kind;
    if (kind !== 'context' && kind !== 'remove' && kind !== 'add') return null;
    if (typeof item.text !== 'string') return null;
    const oldLine = typeof item.oldLine === 'number' && Number.isFinite(item.oldLine) ? item.oldLine : undefined;
    const newLine = typeof item.newLine === 'number' && Number.isFinite(item.newLine) ? item.newLine : undefined;
    lines.push({ kind, text: item.text, oldLine, newLine });
  }

  return {
    kind: 'file_edit',
    path: record.path,
    contextLines: typeof record.contextLines === 'number' ? record.contextLines : undefined,
    oldStartLine: typeof record.oldStartLine === 'number' ? record.oldStartLine : undefined,
    newStartLine: typeof record.newStartLine === 'number' ? record.newStartLine : undefined,
    removedLines: typeof record.removedLines === 'number' ? record.removedLines : undefined,
    addedLines: typeof record.addedLines === 'number' ? record.addedLines : undefined,
    source: 'file_context',
    lines,
  };
}

function editDiffDetailsFromText(path: string, oldText: string, newText: string): EditDiffDetails {
  const oldLines = displayLines(oldText);
  const newLines = displayLines(newText);
  let prefixLength = 0;
  const prefixMax = Math.min(oldLines.length, newLines.length);
  while (prefixLength < prefixMax && oldLines[prefixLength] === newLines[prefixLength]) prefixLength++;

  let suffixLength = 0;
  const suffixMax = Math.min(oldLines.length, newLines.length) - prefixLength;
  while (
    suffixLength < suffixMax &&
    oldLines[oldLines.length - 1 - suffixLength] === newLines[newLines.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }

  const oldRemoveStart = prefixLength;
  const oldRemoveEnd = oldLines.length - suffixLength;
  const newAddStart = prefixLength;
  const newAddEnd = newLines.length - suffixLength;
  const lines: EditDiffLine[] = [];

  for (let index = 0; index < prefixLength; index++) {
    lines.push({ kind: 'context', oldLine: index + 1, newLine: index + 1, text: oldLines[index] ?? '' });
  }
  for (let index = oldRemoveStart; index < oldRemoveEnd; index++) {
    lines.push({ kind: 'remove', oldLine: index + 1, text: oldLines[index] ?? '' });
  }
  for (let index = newAddStart; index < newAddEnd; index++) {
    lines.push({ kind: 'add', newLine: index + 1, text: newLines[index] ?? '' });
  }
  for (let index = suffixLength - 1; index >= 0; index--) {
    const oldIndex = oldLines.length - 1 - index;
    const newIndex = newLines.length - 1 - index;
    lines.push({
      kind: 'context',
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
      text: oldLines[oldIndex] ?? newLines[newIndex] ?? '',
    });
  }

  return {
    kind: 'file_edit',
    path,
    contextLines: 0,
    oldStartLine: oldRemoveStart + 1,
    newStartLine: newAddStart + 1,
    removedLines: Math.max(0, oldRemoveEnd - oldRemoveStart),
    addedLines: Math.max(0, newAddEnd - newAddStart),
    source: 'input',
    lines,
  };
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().split(/[.:/]/).pop() ?? toolName.toLowerCase();
}

function truncate(str: string, max = 80): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}

function previewText(str: string, max = 12000): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n\n... truncated ${str.length - max} characters`;
}

function splitLines(str: string): string[] {
  return str.length === 0 ? [''] : str.replace(/\r\n/g, '\n').split('\n');
}

function displayLines(str: string): string[] {
  const lines = splitLines(str);
  return str.length > 0 && lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function lineCount(str: string): number {
  if (str.length === 0) return 0;
  return displayLines(str).length;
}

function rangeFromNumbers(values: Array<number | undefined>): LineRange | null {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!numbers.length) return null;
  return { start: Math.min(...numbers), end: Math.max(...numbers) };
}

function formatLineRange(range: LineRange | null): string | undefined {
  if (!range) return undefined;
  return range.start === range.end ? `L${range.start}` : `L${range.start}-L${range.end}`;
}

function formatHumanLineRange(range: LineRange | null): string | undefined {
  if (!range) return undefined;
  return range.start === range.end ? `第 ${range.start} 行` : `第 ${range.start}-${range.end} 行`;
}

function changedLineRange(details: EditDiffDetails): LineRange | null {
  const changed = details.lines.filter((line) => line.kind !== 'context');
  const added = rangeFromNumbers(changed.map((line) => line.newLine));
  const removed = rangeFromNumbers(changed.map((line) => line.oldLine));
  if (!added) return removed;
  if (!removed) return added;
  return { start: Math.min(added.start, removed.start), end: Math.max(added.end, removed.end) };
}

function hunkRange(values: Array<number | undefined>, fallback?: number): { start: number; count: number } {
  const range = rangeFromNumbers(values);
  if (range) return { start: range.start, count: range.end - range.start + 1 };
  return { start: fallback ?? 0, count: 0 };
}

function formatHunkHeader(details: EditDiffDetails): string {
  const oldRange = hunkRange(details.lines.map((line) => line.oldLine), details.oldStartLine);
  const newRange = hunkRange(details.lines.map((line) => line.newLine), details.newStartLine);
  return `@@ -${oldRange.start},${oldRange.count} +${newRange.start},${newRange.count} @@`;
}

function commonPrefixChars(left: string[], right: string[]): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index++;
  return index;
}

function commonSuffixChars(left: string[], right: string[], prefixLength: number): number {
  const max = Math.min(left.length, right.length) - prefixLength;
  let count = 0;
  while (count < max && left[left.length - 1 - count] === right[right.length - 1 - count]) count++;
  return count;
}

function changedTextSegments(text: string, peer?: string): Array<{ text: string; changed: boolean }> {
  if (peer === undefined || text.length === 0 || text === peer) return [{ text, changed: false }];
  const left = Array.from(text);
  const right = Array.from(peer);
  const prefixLength = commonPrefixChars(left, right);
  const suffixLength = commonSuffixChars(left, right, prefixLength);
  const segments: Array<{ text: string; changed: boolean }> = [];
  const prefix = left.slice(0, prefixLength).join('');
  const changed = left.slice(prefixLength, left.length - suffixLength).join('');
  const suffix = suffixLength ? left.slice(left.length - suffixLength).join('') : '';
  if (prefix) segments.push({ text: prefix, changed: false });
  if (changed) segments.push({ text: changed, changed: true });
  if (suffix) segments.push({ text: suffix, changed: false });
  return segments.length ? segments : [{ text, changed: false }];
}

function LinePreview({
  lines,
  marker,
  tone,
}: {
  lines: string[];
  marker?: string;
  tone: 'plain' | 'add' | 'remove';
}) {
  const toneClass =
    tone === 'add'
      ? 'border-emerald-200 bg-emerald-50/70 text-emerald-950'
      : tone === 'remove'
        ? 'border-rose-200 bg-rose-50/70 text-rose-950'
        : 'border-zinc-200 bg-zinc-50 text-zinc-700';
  const markerClass = tone === 'add' ? 'text-emerald-600' : tone === 'remove' ? 'text-rose-600' : 'text-zinc-400';

  return (
    <div
      className={`max-h-80 overflow-y-auto rounded-md border p-2 font-mono text-xs leading-5 whitespace-pre-wrap ${toneClass}`}
    >
      {lines.map((line, index) => (
        <div key={index} className="flex min-w-0 gap-2">
          {marker && <span className={`w-3 shrink-0 select-none text-right ${markerClass}`}>{marker}</span>}
          <span className="min-w-0 flex-1 break-words">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function DiffText({
  text,
  peerText,
  tone,
}: {
  text: string;
  peerText?: string;
  tone: 'add' | 'remove' | 'context';
}) {
  const changedClass =
    tone === 'add'
      ? 'rounded-sm bg-emerald-200/80 text-emerald-950'
      : tone === 'remove'
        ? 'rounded-sm bg-rose-200/80 text-rose-950'
        : '';
  return (
    <>
      {changedTextSegments(text || ' ', peerText).map((segment, index) => (
        <span key={index} className={segment.changed ? changedClass : undefined}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

function pairedChangedLine(lines: EditDiffLine[], index: number): string | undefined {
  const current = lines[index];
  if (!current || current.kind === 'context') return undefined;
  const previous = lines[index - 1];
  const next = lines[index + 1];
  if (current.kind === 'remove' && next?.kind === 'add') return next.text;
  if (current.kind === 'add' && previous?.kind === 'remove') return previous.text;
  return undefined;
}

function DiffLinePreview({ details, locationLabel }: { details: EditDiffDetails; locationLabel: string }) {
  return (
    <div className="max-h-96 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50/80 p-2 font-mono text-xs leading-5 whitespace-pre-wrap">
      <div className="-mx-2 mb-1 flex min-w-0 gap-2 border-b border-zinc-200 bg-white/80 px-2 pb-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">
        <span className="w-8 shrink-0 select-none text-right">old</span>
        <span className="w-8 shrink-0 select-none text-right">new</span>
        <span className="w-3 shrink-0" />
        <span className="min-w-0 flex-1 normal-case tracking-normal text-zinc-500">
          <span className="font-sans font-medium text-zinc-700">修改位置 {locationLabel}</span>
          <span className="px-2 text-zinc-300">·</span>
          {formatHunkHeader(details)}
        </span>
      </div>
      {details.lines.map((line, index) => {
        const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
        const rowClass =
          line.kind === 'add'
            ? 'bg-emerald-50 text-emerald-950'
            : line.kind === 'remove'
              ? 'bg-rose-50 text-rose-950'
              : 'text-zinc-700';
        const markerClass =
          line.kind === 'add' ? 'text-emerald-600' : line.kind === 'remove' ? 'text-rose-600' : 'text-zinc-400';
        const lineNumberClass =
          line.kind === 'add'
            ? 'text-emerald-700'
            : line.kind === 'remove'
              ? 'text-rose-700'
              : 'text-zinc-400';

        return (
          <div key={index} className={`-mx-2 flex min-w-0 gap-2 px-2 ${rowClass}`}>
            <span className={`w-8 shrink-0 select-none text-right ${lineNumberClass}`}>{line.oldLine ?? ''}</span>
            <span className={`w-8 shrink-0 select-none text-right ${lineNumberClass}`}>{line.newLine ?? ''}</span>
            <span className={`w-3 shrink-0 select-none text-right ${markerClass}`}>{marker}</span>
            <span className="min-w-0 flex-1 break-words">
              <DiffText
                text={line.text}
                peerText={pairedChangedLine(details.lines, index)}
                tone={line.kind === 'add' ? 'add' : line.kind === 'remove' ? 'remove' : 'context'}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FieldBadge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[10px] text-zinc-500">{children}</span>;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-zinc-400">{children}</div>;
}

function RawDetails({
  inputStr,
  resultStr,
  isError,
  open = false,
}: {
  inputStr: string;
  resultStr: string | null;
  isError: boolean;
  open?: boolean;
}) {
  if (!inputStr && !resultStr) return null;

  return (
    <details open={open} className="mt-3 border-t border-zinc-100 pt-2">
      <summary className="cursor-pointer text-xs text-zinc-400 transition-colors hover:text-zinc-700">原始详情</summary>
      <div className="mt-2">
        {inputStr && (
          <section className="mb-2">
            <SectionLabel>Input</SectionLabel>
            <pre className="max-h-44 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs leading-5 text-zinc-600 whitespace-pre-wrap">
              {truncate(inputStr, 4000)}
            </pre>
          </section>
        )}
        {resultStr && (
          <section>
            <div className={`mb-1 text-[10px] uppercase tracking-[0.18em] ${isError ? 'text-rose-600' : 'text-zinc-400'}`}>
              Output {isError ? 'error' : ''}
            </div>
            <pre
              className={`max-h-64 overflow-y-auto rounded-md border bg-zinc-50 p-2 font-mono text-xs leading-5 whitespace-pre-wrap ${
                isError ? 'border-rose-200 text-rose-700' : 'border-zinc-200 text-zinc-600'
              }`}
            >
              {truncate(resultStr, 6000)}
            </pre>
          </section>
        )}
      </div>
    </details>
  );
}

function ResultNote({ result, isError }: { result: string; isError: boolean }) {
  if (!result) return null;
  return (
    <div
      className={`mt-2 rounded-md border px-2 py-1.5 font-mono text-xs ${
        isError ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-zinc-200 bg-white text-zinc-500'
      }`}
    >
      {truncate(result, 500)}
    </div>
  );
}

function buildFileToolView(entry: ToolCallEntry, resultText: string, isError: boolean): FileToolView | null {
  const kind = normalizedToolName(entry.toolName);
  if (kind !== 'read' && kind !== 'write' && kind !== 'edit') return null;

  const input = inputRecord(entry.input);
  const path = input ? stringField(input, 'path') : undefined;
  if (!input || !path) return null;

  if (kind === 'read') {
    const output = previewText(resultText);
    const lines = displayLines(output);
    const offset = numberField(input, 'offset');
    const limit = numberField(input, 'limit');
    const meta = [offset ? `offset ${offset}` : null, limit ? `limit ${limit}` : null].filter(Boolean).join(' · ');

    return {
      kind,
      path,
      summary: `读取 ${truncateMiddle(path, 34)} · ${lineCount(resultText)} 行`,
      meta: meta || undefined,
      body: (
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <SectionLabel>读取内容</SectionLabel>
            {meta && <FieldBadge>{meta}</FieldBadge>}
          </div>
          {resultText || isError ? (
            <LinePreview lines={lines} tone={isError ? 'remove' : 'plain'} />
          ) : (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500">等待读取结果...</div>
          )}
        </section>
      ),
    };
  }

  if (kind === 'write') {
    const content = stringField(input, 'content') ?? '';
    const contentPreview = previewText(content);
    const contentLines = displayLines(contentPreview);
    const bytes = new TextEncoder().encode(content).length;

    return {
      kind,
      path,
      summary: `写入 ${truncateMiddle(path, 34)} · +${lineCount(content)} 行`,
      meta: `${bytes} bytes`,
      body: (
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <SectionLabel>写入内容</SectionLabel>
            <FieldBadge>+{lineCount(content)} 行 · {bytes} bytes</FieldBadge>
          </div>
          <LinePreview lines={contentLines} marker="+" tone="add" />
          <ResultNote result={resultText} isError={isError} />
        </section>
      ),
    };
  }

  const oldText = stringField(input, 'oldText') ?? '';
  const newText = stringField(input, 'newText') ?? '';
  const details = editDiffDetails(entry.details) ?? editDiffDetailsFromText(path, oldText, newText);
  const removedCount = details.removedLines ?? lineCount(oldText);
  const addedCount = details.addedLines ?? lineCount(newText);
  const changedRange = changedLineRange(details);
  const technicalLineLabel = formatLineRange(changedRange);
  const humanLineLabel = formatHumanLineRange(changedRange);
  const locationLabel = details.source === 'input'
    ? humanLineLabel ? `输入片段 ${humanLineLabel}` : '输入片段'
    : humanLineLabel ?? technicalLineLabel ?? '位置未知';
  const detailMeta = details.source === 'input'
    ? locationLabel
    : `${locationLabel} · 上下文 ±${details.contextLines ?? 0} 行`;

  return {
    kind,
    path,
    summary: `编辑 ${truncateMiddle(path, 34)} · ${locationLabel} · -${removedCount} +${addedCount} 行`,
    meta: detailMeta,
    body: (
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <SectionLabel>编辑对比</SectionLabel>
          <FieldBadge>{detailMeta} · -{removedCount} +{addedCount} 行</FieldBadge>
        </div>
        <DiffLinePreview details={details} locationLabel={locationLabel} />
        <ResultNote result={resultText} isError={isError} />
      </section>
    ),
  };
}

export function ToolCard({ entry }: ToolCardProps) {
  const isPending = entry.status === 'pending';
  const isError = entry.isError === true;
  const [open, setOpen] = useState(isPending || isError);
  const statusLabel = isPending ? 'pending' : isError ? 'error' : 'done';
  const statusClass = isPending
    ? 'border-amber-200 bg-amber-50 text-amber-700'
    : isError
      ? 'border-rose-200 bg-rose-50 text-rose-700'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700';

  const inputStr = formatValue(entry.input);
  const resultStr = entry.result != null ? formatValue(entry.result) : null;
  const resultText = plainText(entry.result);
  const fileToolView = buildFileToolView(entry, resultText, isError);
  const summary = fileToolView?.summary || entry.progress || inputStr || resultStr || 'No details yet';

  useEffect(() => {
    if (isPending || isError) setOpen(true);
  }, [isError, isPending]);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={`overflow-hidden rounded-lg text-sm ${surface.panel}`}>
      <Collapsible.Trigger
        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-50 ${surface.focus}`}
      >
        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${statusClass}`}>{statusLabel}</span>
        <span className="min-w-0 shrink-0 font-mono text-xs font-medium text-zinc-900">{entry.toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">{truncateMiddle(summary, 46)}</span>
        <span className="text-xs text-zinc-400">details</span>
      </Collapsible.Trigger>

      <Collapsible.Panel keepMounted className="border-t border-zinc-200 px-3 py-2">
        {fileToolView ? (
          <>
            <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-xs font-medium text-zinc-800">{fileToolView.path}</span>
              {fileToolView.meta && <FieldBadge>{fileToolView.meta}</FieldBadge>}
            </div>
            {fileToolView.body}
            <RawDetails inputStr={inputStr} resultStr={resultStr} isError={isError} />
          </>
        ) : (
          <RawDetails inputStr={inputStr} resultStr={resultStr} isError={isError} open />
        )}
        {isPending && !resultStr && <div className="py-2 text-xs text-zinc-500">Waiting for result...</div>}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
