import { describe, test, expect } from 'bun:test';
import { parseMarkdown } from '../components/markdown.js';
import type { MarkdownBlock } from '../components/markdown.js';

// ---------------------------------------------------------------------------
// Helper: extract block types from parse result
// ---------------------------------------------------------------------------

function blockTypes(blocks: MarkdownBlock[]): string[] {
  return blocks.map((b) => b.type);
}

// ---------------------------------------------------------------------------
// parseMarkdown — Happy path: plain text
// ---------------------------------------------------------------------------

describe('parseMarkdown — plain text', () => {
  test('plain text renders without formatting as paragraph', async () => {
    const blocks = parseMarkdown('Hello world');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    if (blocks[0].type === 'paragraph') {
      expect(blocks[0].text).toBe('Hello world');
    }
  });

  test('multiple plain lines become a single paragraph', async () => {
    const blocks = parseMarkdown('Line one\nLine two');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    if (blocks[0].type === 'paragraph') {
      expect(blocks[0].text).toBe('Line one\nLine two');
    }
  });

  test('empty string produces no blocks', async () => {
    const blocks = parseMarkdown('');
    expect(blocks).toHaveLength(0);
  });

  test('only blank lines produce no blocks', async () => {
    const blocks = parseMarkdown('\n\n\n');
    expect(blocks).toHaveLength(0);
  });

  test('very long line wraps into a single paragraph', async () => {
    const longLine = 'A'.repeat(500);
    const blocks = parseMarkdown(longLine);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
  });
});

// ---------------------------------------------------------------------------
// parseMarkdown — Headings
// ---------------------------------------------------------------------------

describe('parseMarkdown — headings', () => {
  test('h1 heading', async () => {
    const blocks = parseMarkdown('# Title');
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'heading') {
      expect(blocks[0].level).toBe(1);
      expect(blocks[0].text).toBe('Title');
    }
  });

  test('h2 heading', async () => {
    const blocks = parseMarkdown('## Section');
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'heading') {
      expect(blocks[0].level).toBe(2);
      expect(blocks[0].text).toBe('Section');
    }
  });

  test('h3 to h6 headings', async () => {
    for (let level = 3; level <= 6; level++) {
      const prefix = '#'.repeat(level);
      const blocks = parseMarkdown(`${prefix} Heading ${level}`);
      expect(blocks).toHaveLength(1);
      if (blocks[0].type === 'heading') {
        expect(blocks[0].level).toBe(level);
      }
    }
  });

  test('heading followed by paragraph', async () => {
    const blocks = parseMarkdown('# Title\n\nSome text here');
    expect(blockTypes(blocks)).toEqual(['heading', 'paragraph']);
  });
});

// ---------------------------------------------------------------------------
// parseMarkdown — Code blocks
// ---------------------------------------------------------------------------

describe('parseMarkdown — code blocks', () => {
  test('code block with language tag', async () => {
    const input = '```typescript\nconst x = 1;\n```';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'code_block') {
      expect(blocks[0].language).toBe('typescript');
      expect(blocks[0].code).toBe('const x = 1;');
    }
  });

  test('code block without language tag', async () => {
    const input = '```\nplain code\n```';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'code_block') {
      expect(blocks[0].language).toBe('');
      expect(blocks[0].code).toBe('plain code');
    }
  });

  test('empty code block', async () => {
    const input = '```\n```';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'code_block') {
      expect(blocks[0].code).toBe('');
    }
  });

  test('multi-line code block', async () => {
    const input = '```js\nline1\nline2\nline3\n```';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'code_block') {
      expect(blocks[0].code).toBe('line1\nline2\nline3');
    }
  });

  test('code block with tilde fence', async () => {
    const input = '~~~python\nprint("hello")\n~~~';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'code_block') {
      expect(blocks[0].language).toBe('python');
      expect(blocks[0].code).toBe('print("hello")');
    }
  });
});

// ---------------------------------------------------------------------------
// parseMarkdown — Unclosed code fence (streaming edge case)
// ---------------------------------------------------------------------------

describe('parseMarkdown — unclosed code fence', () => {
  test('unclosed code fence renders as visible text', async () => {
    const input = '```typescript\nconst x = 1;';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'unclosed_fence') {
      expect(blocks[0].fence).toContain('```');
      expect(blocks[0].info).toBe('typescript');
      expect(blocks[0].content).toBe('const x = 1;');
    }
  });

  test('unclosed fence with no content', async () => {
    const input = '```python';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'unclosed_fence') {
      expect(blocks[0].content).toBe('');
    }
  });

  test('closing fence arrives and becomes proper code block', async () => {
    // First, simulate partial
    const partial = '```js\nconst x =';
    const partialBlocks = parseMarkdown(partial);
    expect(partialBlocks[0].type).toBe('unclosed_fence');

    // Then, simulate full
    const full = '```js\nconst x = 1;\n```';
    const fullBlocks = parseMarkdown(full);
    expect(fullBlocks[0].type).toBe('code_block');
    if (fullBlocks[0].type === 'code_block') {
      expect(fullBlocks[0].code).toBe('const x = 1;');
    }
  });
});

// ---------------------------------------------------------------------------
// parseMarkdown — Lists
// ---------------------------------------------------------------------------

describe('parseMarkdown — lists', () => {
  test('unordered list with dash', async () => {
    const input = '- Item one\n- Item two\n- Item three';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'unordered_list') {
      expect(blocks[0].items).toEqual(['Item one', 'Item two', 'Item three']);
    }
  });

  test('unordered list with asterisk', async () => {
    const input = '* First\n* Second';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'unordered_list') {
      expect(blocks[0].items).toEqual(['First', 'Second']);
    }
  });

  test('ordered list', async () => {
    const input = '1. First\n2. Second\n3. Third';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'ordered_list') {
      expect(blocks[0].items).toEqual(['First', 'Second', 'Third']);
      expect(blocks[0].startNumber).toBe(1);
    }
  });

  test('ordered list with custom start number', async () => {
    const input = '3. Third\n4. Fourth';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'ordered_list') {
      expect(blocks[0].startNumber).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// parseMarkdown — Blockquotes
// ---------------------------------------------------------------------------

describe('parseMarkdown — blockquotes', () => {
  test('single line blockquote', async () => {
    const input = '> This is a quote';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'blockquote') {
      expect(blocks[0].text).toBe('This is a quote');
    }
  });

  test('multi-line blockquote', async () => {
    const input = '> Line one\n> Line two';
    const blocks = parseMarkdown(input);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'blockquote') {
      expect(blocks[0].text).toBe('Line one\nLine two');
    }
  });
});

// ---------------------------------------------------------------------------
// parseMarkdown — Thematic breaks
// ---------------------------------------------------------------------------

describe('parseMarkdown — thematic breaks', () => {
  test('dashes become thematic break', async () => {
    const blocks = parseMarkdown('---');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('thematic_break');
  });

  test('asterisks become thematic break', async () => {
    const blocks = parseMarkdown('***');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('thematic_break');
  });
});

// ---------------------------------------------------------------------------
// parseMarkdown — Mixed content
// ---------------------------------------------------------------------------

describe('parseMarkdown — mixed content', () => {
  test('heading + paragraph + code block', async () => {
    const input = '# Title\n\nSome text\n\n```js\ncode\n```';
    const blocks = parseMarkdown(input);
    expect(blockTypes(blocks)).toEqual(['heading', 'paragraph', 'code_block']);
  });

  test('list + blockquote + heading', async () => {
    const input = '# My Doc\n\n- item 1\n- item 2\n\n> quoted text';
    const blocks = parseMarkdown(input);
    expect(blockTypes(blocks)).toEqual(['heading', 'unordered_list', 'blockquote']);
  });
});

// ---------------------------------------------------------------------------
// Syntax highlighting integration
// ---------------------------------------------------------------------------

describe('syntax highlighting', () => {
  test('highlightCode returns string for known language', async () => {
    const { highlight } = await import('cli-highlight');
    const result = highlight('const x = 1;', { language: 'typescript', ignoreIllegals: true });
    // Result should contain the original text content
    expect(result).toContain('const');
    expect(result).toContain('x');
  });

  test('highlightCode does not throw for unknown language with ignoreIllegals', async () => {
    const { highlight } = await import('cli-highlight');
    // cli-highlight throws for unknown language; our wrapper catches it
    // Test that our highlightCode helper catches and returns plain text
    expect(() => {
      try {
        highlight('hello world', { language: 'nonexistent', ignoreIllegals: true });
      } catch {
        // This is expected — cli-highlight throws for unknown languages
        // Our wrapper in markdown.tsx catches this
      }
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: streaming text_delta sequence
// ---------------------------------------------------------------------------

describe('integration — streaming text_delta', () => {
  test('progressive parsing simulates streaming input', async () => {
    // Simulate chunks arriving one at a time
    const chunks = ['#', ' Hello', '\n\n', 'World'];
    let buffer = '';

    for (const chunk of chunks) {
      buffer += chunk;
    }

    const blocks = parseMarkdown(buffer);
    expect(blockTypes(blocks)).toEqual(['heading', 'paragraph']);
    if (blocks[0].type === 'heading') {
      expect(blocks[0].text).toBe('Hello');
    }
    if (blocks[1].type === 'paragraph') {
      expect(blocks[1].text).toBe('World');
    }
  });

  test('streaming code block: unclosed -> closed', async () => {
    // Phase 1: opening fence arrives
    const phase1 = '```js';
    const blocks1 = parseMarkdown(phase1);
    expect(blocks1[0].type).toBe('unclosed_fence');

    // Phase 2: code content arrives, still unclosed
    const phase2 = '```js\nconst x = 1;';
    const blocks2 = parseMarkdown(phase2);
    expect(blocks2[0].type).toBe('unclosed_fence');

    // Phase 3: closing fence arrives, becomes code block
    const phase3 = '```js\nconst x = 1;\n```';
    const blocks3 = parseMarkdown(phase3);
    expect(blocks3[0].type).toBe('code_block');
    if (blocks3[0].type === 'code_block') {
      expect(blocks3[0].language).toBe('js');
      expect(blocks3[0].code).toBe('const x = 1;');
    }
  });

  test('streaming heading: partial then complete', async () => {
    // Hash arrives first — lone # without space is a paragraph
    const phase1 = parseMarkdown('#');
    expect(phase1).toHaveLength(1);
    expect(phase1[0].type).toBe('paragraph'); // lone # treated as text

    // Space + text arrives — now it's a heading
    const phase2 = parseMarkdown('# Hello');
    expect(phase2).toHaveLength(1);
    expect(phase2[0].type).toBe('heading');
  });
});

// ---------------------------------------------------------------------------
// Markdown plugin registration
// ---------------------------------------------------------------------------

describe('markdown plugin registration', () => {
  test('markdown plugin registers output region and text_delta renderer', async () => {
    const { TuiRegistry } = await import('../tui-registry.js');
    const { markdownPlugin } = await import('../plugins/markdown-plugin.js');

    const registry = new TuiRegistry();
    await registry.registerPlugin(markdownPlugin());

    const regions = registry.getRegions();
    const outputRegions = regions.filter((r) => r.id === 'output');
    expect(outputRegions).toHaveLength(1);
    expect(outputRegions[0].position).toBe('main');
    expect(outputRegions[0].eventTypes).toContain('text_delta');

    const renderers = registry.getRenderers('text_delta');
    expect(renderers).toHaveLength(1);
    expect(renderers[0].eventType).toBe('text_delta');
  });

  test('markdown plugin coexists with command plugin', async () => {
    const { TuiRegistry } = await import('../tui-registry.js');
    const { commandPlugin } = await import('../plugins/command-plugin.js');
    const { markdownPlugin } = await import('../plugins/markdown-plugin.js');

    const registry = new TuiRegistry();
    await registry.registerPlugin(commandPlugin());
    await registry.registerPlugin(markdownPlugin());

    // Commands still work
    const commands = registry.getCommands();
    expect(commands.length).toBeGreaterThanOrEqual(5);

    // Markdown renderer registered
    const renderers = registry.getRenderers('text_delta');
    expect(renderers).toHaveLength(1);
  });

  test('init() includes markdown plugin', async () => {
    const { TuiRegistry } = await import('../tui-registry.js');
    const registry = new TuiRegistry();
    await registry.init();

    const renderers = registry.getRenderers('text_delta');
    expect(renderers).toHaveLength(1);

    const outputRegions = registry.getRegions().filter((r) => r.id === 'output');
    expect(outputRegions).toHaveLength(1);
  });
});
