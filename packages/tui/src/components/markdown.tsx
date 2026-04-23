/**
 * Streaming Markdown Renderer — renders accumulated text as terminal-formatted output.
 *
 * This is a pure renderer: it takes a string (the accumulated text buffer)
 * and returns React elements. It does NOT manage its own buffer.
 *
 * Supported elements:
 *   - Headings (bold + underline)
 *   - Code blocks with syntax highlighting via cli-highlight
 *   - Inline code (colored background)
 *   - Bold / italic (ANSI bold/italic)
 *   - Links [text](url) — shows text with URL in dim
 *   - Lists (bullet and numbered, indented)
 *   - Blockquotes (indented with | prefix)
 *
 * Streaming approach:
 *   - Partial code fence: if buffer ends with an unclosed ```, render backticks as visible text
 *   - When closing fence arrives, render as a code block
 */

import React from 'react';
import { Box, Text } from 'ink';
import { highlight } from 'cli-highlight';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HeadingBlock {
  type: 'heading';
  level: number;
  text: string;
}

interface CodeBlock {
  type: 'code_block';
  language: string;
  code: string;
}

interface UnclosedFenceBlock {
  type: 'unclosed_fence';
  fence: string;
  info: string;
  content: string;
}

interface ParagraphBlock {
  type: 'paragraph';
  text: string;
}

interface ThematicBreakBlock {
  type: 'thematic_break';
}

interface UnorderedListBlock {
  type: 'unordered_list';
  items: string[];
}

interface OrderedListBlock {
  type: 'ordered_list';
  items: string[];
  startNumber: number;
}

interface BlockquoteBlock {
  type: 'blockquote';
  text: string;
}

export type MarkdownBlock =
  | HeadingBlock
  | CodeBlock
  | UnclosedFenceBlock
  | ParagraphBlock
  | ThematicBreakBlock
  | UnorderedListBlock
  | OrderedListBlock
  | BlockquoteBlock;

// ---------------------------------------------------------------------------
// Markdown parser — regex-based line-by-line state machine
// ---------------------------------------------------------------------------

/**
 * Parse raw markdown text into a list of blocks.
 * Exported for testing.
 */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split('\n');

  let i = 0;
  let inCodeBlock = false;
  let codeFence = '';
  let codeLang = '';
  let codeLines: string[] = [];
  let unclosedFence = false;

  // Accumulators for list parsing
  let ulItems: string[] = [];
  let olItems: string[] = [];
  let olStart = 1;

  function flushUl() {
    if (ulItems.length > 0) {
      blocks.push({ type: 'unordered_list', items: ulItems });
      ulItems = [];
    }
  }

  function flushOl() {
    if (olItems.length > 0) {
      blocks.push({ type: 'ordered_list', items: olItems, startNumber: olStart });
      olItems = [];
      olStart = 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // --- Inside a code block ---
    if (inCodeBlock) {
      // Check for closing fence (must match opening fence type and have at least 3 backticks/tildes)
      const closeMatch = line.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[2][0] === codeFence[0] && closeMatch[2].length >= codeFence.length) {
        blocks.push({
          type: 'code_block',
          language: codeLang,
          code: codeLines.join('\n'),
        });
        inCodeBlock = false;
        codeFence = '';
        codeLang = '';
        codeLines = [];
        unclosedFence = false;
        i++;
        continue;
      }

      // Check if this is the last line and we're still open (unclosed fence)
      // Actually we accumulate all lines; unclosed detection happens at end
      codeLines.push(line);
      i++;
      continue;
    }

    // --- Not in a code block ---

    // Check for code fence opening
    const fenceMatch = line.match(/^( {0,3})(`{3,}|~{3,})(.*)/);
    if (fenceMatch) {
      flushUl();
      flushOl();
      codeFence = fenceMatch[2];
      codeLang = fenceMatch[3].trim();
      codeLines = [];
      inCodeBlock = true;
      unclosedFence = true;
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushUl();
      flushOl();
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i++;
      continue;
    }

    // Thematic break
    const hrMatch = line.match(/^( {0,3})([-*_])\s*(\2\s*){2,}$/);
    if (hrMatch) {
      flushUl();
      flushOl();
      blocks.push({ type: 'thematic_break' });
      i++;
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      flushUl();
      flushOl();
      // Accumulate blockquote lines
      const bqLines: string[] = [bqMatch[1]];
      i++;
      while (i < lines.length) {
        const bqLine = lines[i].match(/^>\s?(.*)$/);
        if (bqLine) {
          bqLines.push(bqLine[1]);
          i++;
        } else {
          break;
        }
      }
      blocks.push({
        type: 'blockquote',
        text: bqLines.join('\n'),
      });
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^( {0,3})([-*+])\s+(.+)$/);
    if (ulMatch) {
      flushOl();
      // Flush previous ul if we had a gap (handled by continuation)
      // For simplicity, consecutive list items are grouped
      if (ulItems.length === 0) {
        // Start new list
      }
      ulItems.push(ulMatch[3]);
      i++;
      // Continue accumulating list items
      while (i < lines.length) {
        const nextUl = lines[i].match(/^( {0,3})([-*+])\s+(.+)$/);
        if (nextUl) {
          ulItems.push(nextUl[3]);
          i++;
        } else if (lines[i].trim() === '') {
          // Blank line ends list
          break;
        } else {
          break;
        }
      }
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^( {0,3})(\d+)\.\s+(.+)$/);
    if (olMatch) {
      flushUl();
      if (olItems.length === 0) {
        olStart = parseInt(olMatch[2], 10);
      }
      olItems.push(olMatch[3]);
      i++;
      while (i < lines.length) {
        const nextOl = lines[i].match(/^( {0,3})(\d+)\.\s+(.+)$/);
        if (nextOl) {
          olItems.push(nextOl[3]);
          i++;
        } else if (lines[i].trim() === '') {
          break;
        } else {
          break;
        }
      }
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      flushUl();
      flushOl();
      i++;
      continue;
    }

    // Paragraph — accumulate consecutive non-blank, non-special lines
    flushUl();
    flushOl();
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const nextLine = lines[i];
      // Stop if we hit a special line
      if (nextLine.trim() === '') break;
      if (nextLine.match(/^#{1,6}\s+/)) break;
      if (nextLine.match(/^( {0,3})(`{3,}|~{3,})/)) break;
      if (nextLine.match(/^( {0,3})([-*+])\s+/)) break;
      if (nextLine.match(/^( {0,3})(\d+)\.\s+/)) break;
      if (nextLine.match(/^>\s?/)) break;
      if (nextLine.match(/^( {0,3})([-*_])\s*(\2\s*){2,}$/)) break;
      paraLines.push(nextLine);
      i++;
    }
    blocks.push({
      type: 'paragraph',
      text: paraLines.join('\n'),
    });
  }

  // Flush any remaining list items
  flushUl();
  flushOl();

  // Handle unclosed code fence
  if (inCodeBlock && unclosedFence) {
    // Reconstruct the unclosed fence as visible text
    const fenceLine = codeFence + (codeLang ? ' ' + codeLang : '');
    const content = codeLines.length > 0 ? codeLines.join('\n') : '';
    blocks.push({
      type: 'unclosed_fence',
      fence: fenceLine,
      info: codeLang,
      content,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

interface InlineSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  linkText?: string;
  linkUrl?: string;
}

/**
 * Parse inline formatting: bold, italic, code, links.
 * Returns an array of segments with formatting flags.
 */
function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Try matching inline patterns in order of precedence

    // Inline code: `code` (must be checked before bold/italic since * can be inside code)
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      segments.push({ text: codeMatch[1], bold: false, italic: false, code: true });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      segments.push({
        text: linkMatch[1],
        bold: false,
        italic: false,
        code: false,
        linkText: linkMatch[1],
        linkUrl: linkMatch[2],
      });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Bold+italic: ***text*** or ___text___
    const boldItalicMatch = remaining.match(/^\*\*\*(.+?)\*\*\*/);
    if (boldItalicMatch) {
      segments.push({ text: boldItalicMatch[1], bold: true, italic: true, code: false });
      remaining = remaining.slice(boldItalicMatch[0].length);
      continue;
    }

    // Bold: **text** or __text__
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      segments.push({ text: boldMatch[1], bold: true, italic: false, code: false });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *text* or _text_
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) {
      segments.push({ text: italicMatch[1], bold: false, italic: true, code: false });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Plain text — consume up to the next special character or end
    const nextSpecial = remaining.search(/[`*\[_]/);
    if (nextSpecial === -1) {
      segments.push({ text: remaining, bold: false, italic: false, code: false });
      remaining = '';
    } else if (nextSpecial === 0) {
      // Special char at position 0 that didn't match any pattern — consume 1 char
      segments.push({ text: remaining[0], bold: false, italic: false, code: false });
      remaining = remaining.slice(1);
    } else {
      segments.push({ text: remaining.slice(0, nextSpecial), bold: false, italic: false, code: false });
      remaining = remaining.slice(nextSpecial);
    }
  }

  return segments;
}

/**
 * Render inline-formatted text as an array of Ink <Text> elements.
 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const segments = parseInline(text);
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const key = `${keyPrefix}-inline-${i}`;

    if (seg.code) {
      nodes.push(
        <Text key={key} backgroundColor="gray" color="white">
          {seg.text}
        </Text>,
      );
    } else if (seg.linkUrl) {
      nodes.push(
        <Text key={key} color="cyan" underline>
          {seg.linkText}
        </Text>,
      );
      nodes.push(
        <Text key={`${key}-url`} dimColor>
          {' (' + seg.linkUrl + ')'}
        </Text>,
      );
    } else if (seg.bold && seg.italic) {
      nodes.push(
        <Text key={key} bold italic>
          {seg.text}
        </Text>,
      );
    } else if (seg.bold) {
      nodes.push(
        <Text key={key} bold>
          {seg.text}
        </Text>,
      );
    } else if (seg.italic) {
      nodes.push(
        <Text key={key} italic>
          {seg.text}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={key}>{seg.text}</Text>,
      );
    }
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

/**
 * Apply syntax highlighting to code using cli-highlight.
 * Falls back to plain text if highlighting fails.
 */
function highlightCode(code: string, language: string): string {
  try {
    return highlight(code, {
      language: language || undefined,
      ignoreIllegals: true,
    });
  } catch {
    return code;
  }
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

function renderBlock(block: MarkdownBlock, index: number): React.ReactNode {
  switch (block.type) {
    case 'heading': {
      const headingText = block.text;
      return (
        <Box key={`h-${index}`} flexDirection="column">
          <Text bold underline>
            {headingText}
          </Text>
        </Box>
      );
    }

    case 'code_block': {
      return (
        <CodeBlockWithHighlight
          key={`code-${index}`}
          language={block.language}
          code={block.code}
        />
      );
    }

    case 'unclosed_fence': {
      // Render the fence and content as visible text
      const lines: string[] = [];
      lines.push(block.fence);
      if (block.content) {
        lines.push(...block.content.split('\n'));
      }
      return (
        <Box key={`unclosed-${index}`} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i}>{line || ' '}</Text>
          ))}
        </Box>
      );
    }

    case 'paragraph': {
      return (
        <Text key={`p-${index}`}>
          {renderInline(block.text, `p-${index}`)}
        </Text>
      );
    }

    case 'thematic_break': {
      return (
        <Text key={`hr-${index}`} dimColor>
          {'─'.repeat(40)}
        </Text>
      );
    }

    case 'unordered_list': {
      return (
        <Box key={`ul-${index}`} flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i}>
              <Text dimColor>{'  \u2022 '}</Text>
              {renderInline(item, `ul-${index}-${i}`)}
            </Text>
          ))}
        </Box>
      );
    }

    case 'ordered_list': {
      return (
        <Box key={`ol-${index}`} flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i}>
              <Text dimColor>{`  ${block.startNumber + i}. `}</Text>
              {renderInline(item, `ol-${index}-${i}`)}
            </Text>
          ))}
        </Box>
      );
    }

    case 'blockquote': {
      const bqLines = block.text.split('\n');
      return (
        <Box key={`bq-${index}`} flexDirection="column">
          {bqLines.map((line, i) => (
            <Text key={i}>
              <Text color="gray">{'\u2502 '}</Text>
              <Text dimColor>{line}</Text>
            </Text>
          ))}
        </Box>
      );
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Code block with syntax highlighting
// ---------------------------------------------------------------------------

/**
 * Code block renderer that attempts syntax highlighting via cli-highlight.
 * Falls back to plain text if highlighting fails.
 */
function CodeBlockWithHighlight({ language, code }: { language: string; code: string }): React.ReactElement {
  const highlighted = highlightCode(code, language);
  const highlightedLines = highlighted.split('\n');

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
        {language && (
          <Text dimColor>{language}</Text>
        )}
        {highlightedLines.map((line, i) => (
          <Text key={i}>{line || ' '}</Text>
        ))}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main Markdown component
// ---------------------------------------------------------------------------

export interface MarkdownProps {
  /** The accumulated text buffer to render as markdown. */
  text: string;
}

/**
 * Streaming Markdown component.
 *
 * Takes the accumulated text buffer and renders it as terminal-formatted output.
 * Ink's reconciliation handles diffing between renders.
 */
export function Markdown({ text }: MarkdownProps): React.ReactElement {
  if (!text) {
    return <></>;
  }

  const blocks = parseMarkdown(text);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => renderBlock(block, i))}
    </Box>
  );
}
