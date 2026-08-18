import { describe, expect, test } from 'bun:test';
import type { TuiAgentSpecInfo } from '../runtime-session.js';
import {
  agentSpecModeLabel,
  agentSpecVisibleWindow,
  filterAgentSpecs,
  moveAgentSpecSelection,
  truncateAgentSpecText,
} from '../components/agent-spec-picker.js';

const specs: TuiAgentSpecInfo[] = [
  {
    schemaVersion: 1,
    name: 'reviewer',
    path: '/repo/agents/reviewer.json',
    relativePath: 'agents/reviewer.json',
    sourceRoot: '/repo',
    promptPreview: 'Review current changes for correctness',
    toolMode: 'read-only',
    approvalMode: 'deny',
  },
  {
    schemaVersion: 1,
    name: 'builder',
    path: '/repo/examples/skill-packs/basic/agents/builder.json',
    relativePath: 'examples/skill-packs/basic/agents/builder.json',
    sourceRoot: '/repo',
    promptPreview: 'Implement the requested feature',
    toolMode: 'coding',
    approvalMode: 'interactive',
  },
];

describe('AgentSpec picker helpers', () => {
  test('empty filter returns all AgentSpecs', () => {
    expect(filterAgentSpecs(specs, '')).toEqual(specs);
  });

  test('filters by name, relative path, prompt preview, tool mode, and approval mode', () => {
    expect(filterAgentSpecs(specs, 'reviewer').map((spec) => spec.name)).toEqual(['reviewer']);
    expect(filterAgentSpecs(specs, 'skill-packs').map((spec) => spec.name)).toEqual(['builder']);
    expect(filterAgentSpecs(specs, 'correctness').map((spec) => spec.name)).toEqual(['reviewer']);
    expect(filterAgentSpecs(specs, 'coding').map((spec) => spec.name)).toEqual(['builder']);
    expect(filterAgentSpecs(specs, 'interactive').map((spec) => spec.name)).toEqual(['builder']);
  });

  test('filter is case-insensitive and trims whitespace', () => {
    expect(filterAgentSpecs(specs, '  REVIEW  ').map((spec) => spec.name)).toEqual(['reviewer']);
  });

  test('returns empty array when no AgentSpecs match', () => {
    expect(filterAgentSpecs(specs, 'nonexistent')).toEqual([]);
  });

  test('selection movement wraps and handles empty lists', () => {
    expect(moveAgentSpecSelection(0, 'down', 2)).toBe(1);
    expect(moveAgentSpecSelection(1, 'down', 2)).toBe(0);
    expect(moveAgentSpecSelection(0, 'up', 2)).toBe(1);
    expect(moveAgentSpecSelection(0, 'down', 0)).toBe(-1);
  });

  test('visible window keeps the selected AgentSpec inside the rendered rows', () => {
    expect(agentSpecVisibleWindow(20, 0, 10)).toEqual({ start: 0, selected: 0 });
    expect(agentSpecVisibleWindow(20, 9, 10)).toEqual({ start: 0, selected: 9 });
    expect(agentSpecVisibleWindow(20, 10, 10)).toEqual({ start: 1, selected: 9 });
    expect(agentSpecVisibleWindow(20, 19, 10)).toEqual({ start: 10, selected: 9 });
    expect(agentSpecVisibleWindow(20, -1, 10)).toEqual({ start: 0, selected: 0 });
    expect(agentSpecVisibleWindow(0, 0, 10)).toEqual({ start: 0, selected: -1 });
  });

  test('mode label falls back when a spec has default controls', () => {
    expect(agentSpecModeLabel(specs[0])).toBe('read-only / deny');
    expect(agentSpecModeLabel({ ...specs[0], toolMode: undefined, approvalMode: undefined })).toBe('default controls');
  });

  test('truncateAgentSpecText keeps short text and truncates long text', () => {
    expect(truncateAgentSpecText('short', 10)).toBe('short');
    expect(truncateAgentSpecText('abcdefghijklmnop', 10)).toBe('abcdefg...');
  });
});
