import { describe, test, expect } from 'bun:test';
import { TuiStore } from '../store.js';
import {
  buildOutputLines,
  compactToolContent,
  shouldShowThinking,
} from '../components/output-region.js';
import type { TurnEntry } from '../types/tui-state.js';

describe('TuiStore scroll', () => {
  test('initial state has autoFollow=true and scrollOffset=0', () => {
    const store = new TuiStore();
    expect(store.getState().autoFollow).toBe(true);
    expect(store.getState().scrollOffset).toBe(0);
  });

  test('scrollUp increases offset and disables autoFollow', () => {
    const store = new TuiStore();
    store.scrollUp(10);
    expect(store.getState().scrollOffset).toBe(10);
    expect(store.getState().autoFollow).toBe(false);
  });

  test('scrollDown decreases offset, autoFollow when reaching 0', () => {
    const store = new TuiStore();
    store.scrollUp(20);
    store.scrollDown(10);
    expect(store.getState().scrollOffset).toBe(10);
    expect(store.getState().autoFollow).toBe(false);
    store.scrollDown(10);
    expect(store.getState().scrollOffset).toBe(0);
    expect(store.getState().autoFollow).toBe(true);
  });

  test('scrollDown clamps to 0', () => {
    const store = new TuiStore();
    store.scrollUp(5);
    store.scrollDown(100);
    expect(store.getState().scrollOffset).toBe(0);
  });

  test('scrollToBottom resets offset and enables autoFollow', () => {
    const store = new TuiStore();
    store.scrollUp(50);
    expect(store.getState().scrollOffset).toBe(50);
    store.scrollToBottom();
    expect(store.getState().scrollOffset).toBe(0);
    expect(store.getState().autoFollow).toBe(true);
  });

  test('reset clears scroll state', () => {
    const store = new TuiStore();
    store.scrollUp(100);
    store.reset();
    expect(store.getState().scrollOffset).toBe(0);
    expect(store.getState().autoFollow).toBe(true);
  });
});

describe('OutputRegion helpers', () => {
  test('buildOutputLines keeps the full turn history for terminal scrollback', () => {
    const turns: TurnEntry[] = Array.from({ length: 6 }, (_, index) => ({
      role: 'assistant',
      content: `turn ${index}`,
      timestamp: index,
    }));

    const lines = buildOutputLines({
      showThinking: false,
      currentText: '',
      turns,
    }).map((line) => line.text);

    expect(lines).toContain('  turn 0');
    expect(lines).toContain('  turn 5');
    expect(lines).not.toContain('earlier output line hidden');
    expect(lines).not.toContain('earlier turns hidden');
  });

  test('shouldShowThinking hides reasoning once assistant text is visible', () => {
    expect(shouldShowThinking('checking context', '')).toBe(true);
    expect(shouldShowThinking('checking context', 'answer started')).toBe(false);
    expect(shouldShowThinking('   ', '')).toBe(false);
  });

  test('compactToolContent truncates verbose tool output', () => {
    expect(compactToolContent('a\nb\nc\nd', 2)).toEqual(['a', 'b', '... 2 more lines']);
  });

  test('buildOutputLines flattens markdown into terminal lines', () => {
    const lines = buildOutputLines({
      showThinking: false,
      currentText: '# Heading\n\n- one\n- two\n\n```ts\nconst x = 1;\n```',
      turns: [],
    }).map((line) => line.text);

    expect(lines).toEqual([
      'cortx',
      '  Heading',
      '    • one',
      '    • two',
      '  ``` ts',
      '    const x = 1;',
      '  ```',
    ]);
  });
});
