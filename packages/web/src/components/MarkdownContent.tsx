import { useMemo, type ReactNode } from 'react';

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

type MarkdownBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: HeadingLevel; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'quote'; text: string }
  | { type: 'hr' };

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRow(line: string): boolean {
  return line.includes('|') && splitTableRow(line).length > 1;
}

function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { language: string; lines: string[] } | null = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', text: paragraph.join('\n').trimEnd() });
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
    list = null;
  }

  function flushCode() {
    if (!code) return;
    blocks.push({ type: 'code', language: code.language, code: code.lines.join('\n') });
    code = null;
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const trimmed = line.trim();

    if (code) {
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        flushCode();
      } else {
        code.lines.push(line);
      }
      continue;
    }

    const fence = trimmed.match(/^(```|~~~)\s*([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      code = { language: fence[2] ?? '', lines: [] };
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (
      isTableRow(trimmed) &&
      lineIndex + 1 < lines.length &&
      isTableSeparator(lines[lineIndex + 1].trim())
    ) {
      flushParagraph();
      flushList();
      const headers = splitTableRow(trimmed);
      const rows: string[][] = [];
      lineIndex += 2;
      while (lineIndex < lines.length && lines[lineIndex].trim() && isTableRow(lines[lineIndex])) {
        rows.push(splitTableRow(lines[lineIndex]));
        lineIndex++;
      }
      lineIndex--;
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: heading[1].length as HeadingLevel, text: heading[2] });
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'hr' });
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextOrdered = Boolean(ordered);
      if (!list || list.ordered !== nextOrdered) flushList();
      if (!list) list = { ordered: nextOrdered, items: [] };
      list.items.push((ordered ?? unordered)![1]);
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'quote', text: trimmed.replace(/^>\s?/, '') });
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushCode();
  flushParagraph();
  flushList();
  return blocks;
}

function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:|\/|#)/i.test(href);
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^)]+\))/g).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code key={index} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.92em] text-zinc-800">
          {part.slice(1, -1)}
        </code>,
      );
    } else if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(<strong key={index} className="font-semibold text-zinc-950">{part.slice(2, -2)}</strong>);
    } else {
      const link = part.match(/^\[([^\]\n]+)\]\(([^)]+)\)$/);
      if (link && isSafeHref(link[2])) {
        nodes.push(
          <a key={index} href={link[2]} className="font-medium text-sky-700 underline decoration-sky-300 underline-offset-2">
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(part);
      }
    }
  }
  return nodes;
}

function headingClass(level: HeadingLevel): string {
  if (level === 1) return 'text-xl font-semibold tracking-tight text-zinc-950';
  if (level === 2) return 'text-lg font-semibold tracking-tight text-zinc-950';
  if (level === 3) return 'text-base font-semibold text-zinc-900';
  if (level === 4) return 'text-sm font-semibold text-zinc-900';
  if (level === 5) return 'text-sm font-medium text-zinc-800';
  return 'text-xs font-semibold uppercase tracking-[0.08em] text-zinc-600';
}

export function MarkdownContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <div className="space-y-3 break-words">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Tag = (`h${block.level}`) as HeadingTag;
          const className = headingClass(block.level);
          return <Tag key={index} className={className}>{inline(block.text)}</Tag>;
        }
        if (block.type === 'code') {
          return (
            <div key={index} className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-950">
              {block.language && (
                <div className="border-b border-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">
                  {block.language}
                </div>
              )}
              <pre className="overflow-x-auto p-3 text-xs leading-5 text-zinc-100">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={index} className={`space-y-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}
            </Tag>
          );
        }
        if (block.type === 'table') {
          return (
            <div key={index} className="overflow-x-auto rounded-lg border border-zinc-200">
              <table className="min-w-full border-collapse text-sm">
                <thead className="bg-zinc-50 text-zinc-700">
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={headerIndex} className="border-b border-zinc-200 px-3 py-2 text-left font-semibold">
                        {inline(header)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-zinc-100">
                      {block.headers.map((_, cellIndex) => (
                        <td key={cellIndex} className="px-3 py-2 align-top text-zinc-700">
                          {inline(row[cellIndex] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === 'quote') {
          return (
            <blockquote key={index} className="border-l-2 border-zinc-300 pl-3 text-zinc-600">
              {inline(block.text)}
            </blockquote>
          );
        }
        if (block.type === 'hr') {
          return <hr key={index} className="border-zinc-200" />;
        }
        return (
          <p key={index} className="whitespace-pre-wrap leading-7">
            {inline(block.text)}
            {streaming && index === blocks.length - 1 && (
              <span className="ml-1 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-emerald-300 align-text-bottom" />
            )}
          </p>
        );
      })}
      {streaming && blocks.length === 0 && (
        <span className="inline-block h-4 w-1.5 animate-pulse rounded-sm bg-emerald-300 align-text-bottom" />
      )}
    </div>
  );
}
