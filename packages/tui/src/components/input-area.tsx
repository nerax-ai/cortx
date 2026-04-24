import { useState, useRef, useEffect, useSyncExternalStore, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TuiStore } from '../store.js';
import type { TuiState } from '../types/tui-state.js';
import { colors } from '../theme.js';

// Stable module-level selectors to avoid Map key fragmentation in TuiStore
const selectTokenUsage = (s: TuiState) => s.tokenUsage;
const selectIteration = (s: TuiState) => s.iteration;
const selectElapsed = (s: TuiState) => s.elapsed;
const selectTotalElapsed = (s: TuiState) => s.totalElapsed;
const selectToolCalls = (s: TuiState) => s.toolCalls;

export interface InputAreaProps {
  onSubmit: (value: string) => void;
  isRunning: boolean;
  onAbort?: () => void;
  onForceExit?: () => void;
  onOpenPalette?: () => void;
  onPaletteNavigate?: (dir: 'up' | 'down') => void;
  onPaletteSelect?: () => void;
  onPaletteClose?: () => void;
  onPaletteFilterChange?: (filter: string) => void;
  overlayActive?: boolean;
  paletteOpen?: boolean;
  store: TuiStore;
  model: string;
  /** When set, replaces the input field value (used after skill selection from palette). */
  injectedValue?: string;
}

/** Cursor position within the multi-line input */
export interface CursorPosition {
  row: number;
  col: number;
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

export function navigateHistory(
  history: string[],
  historyIndex: number,
  direction: 'up' | 'down',
): { history: string[]; historyIndex: number; value: string } {
  if (history.length === 0) {
    return { history, historyIndex, value: '' };
  }

  if (direction === 'up') {
    const newIndex = Math.min(historyIndex + 1, history.length - 1);
    return { history, historyIndex: newIndex, value: history[newIndex] };
  } else {
    const newIndex = Math.max(historyIndex - 1, -1);
    return {
      history,
      historyIndex: newIndex,
      value: newIndex === -1 ? '' : history[newIndex],
    };
  }
}

export function pushHistory(history: string[], value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return history;
  if (history.length > 0 && history[0] === trimmed) return history;
  return [trimmed, ...history].slice(0, 1000);
}

export function getCursorPosition(value: string): CursorPosition {
  const lines = value.split('\n');
  return {
    row: lines.length - 1,
    col: lines[lines.length - 1].length,
  };
}

export function insertText(value: string, text: string): string {
  return value + text;
}

export function handleBackspace(value: string): string {
  if (value.length === 0) return value;
  return value.slice(0, -1);
}

export type CtrlCAction = 'clear' | 'exit' | 'abort' | 'force-exit' | 'noop';

export function resolveCtrlCAction(
  status: 'idle' | 'running' | 'interrupting',
  inputValue: string,
): CtrlCAction {
  switch (status) {
    case 'idle':
      return inputValue.length > 0 ? 'clear' : 'exit';
    case 'running':
      return 'abort';
    case 'interrupting':
      return 'force-exit';
    default:
      return 'noop';
  }
}

export function openInEditor(initialContent: string): string | null {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const tmpPath = join(tmpdir(), `cortx-input-${Date.now()}.md`);

  try {
    writeFileSync(tmpPath, initialContent, 'utf8');

    const result = spawnSync(editor, [tmpPath], {
      stdio: 'inherit',
      encoding: 'utf8',
    });

    if (result.error || result.status !== 0) {
      return null;
    }

    const content = readFileSync(tmpPath, 'utf8');
    return content.trim();
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ActivityState = 'idle' | 'thinking' | 'executing' | 'interrupting' | 'error';

function deriveActivity(
  status: string,
  toolCalls: Map<string, { status: string; toolName: string }>,
): ActivityState {
  if (status === 'interrupting') return 'interrupting';
  if (status === 'error') return 'error';
  if (status === 'running') {
    const hasPending = [...toolCalls.values()].some((e) => e.status === 'pending');
    return hasPending ? 'executing' : 'thinking';
  }
  return 'idle';
}

function ActivityIndicator({
  activity,
  model,
  iteration,
  elapsed,
  totalElapsed,
  tokenUsage,
  toolCalls,
}: {
  activity: ActivityState;
  model: string;
  iteration: number;
  elapsed: number;
  totalElapsed: number;
  tokenUsage: { inputTokens: number; outputTokens: number };
  toolCalls: Map<string, { status: string; toolName: string }>;
}) {
  const parts: { key: string; node: React.ReactNode }[] = [];

  switch (activity) {
    case 'thinking':
      parts.push({ key: 'status', node: <Text color={colors.activityThinking} bold>{'⏳'} Thinking...</Text> });
      break;
    case 'executing': {
      const latestTool = [...toolCalls.values()].find((e) => e.status === 'pending');
      const name = latestTool?.toolName ?? 'tool';
      parts.push({ key: 'status', node: <Text color={colors.activityExecuting} bold>{'⚙'} {name}</Text> });
      break;
    }
    case 'interrupting':
      parts.push({ key: 'status', node: <Text color={colors.activityInterrupt} bold>{'⏹'} Interrupting...</Text> });
      break;
    case 'error':
      parts.push({ key: 'status', node: <Text color={colors.activityError} bold>{'✗'} Error</Text> });
      break;
    default:
      parts.push({ key: 'status', node: <Text color={colors.activityIdle}>{'✓'} Ready</Text> });
      break;
  }

  parts.push({ key: 'model', node: <Text dimColor>{' │ '} {model}</Text> });

  if (iteration > 0 && activity !== 'idle') {
    parts.push({ key: 'iter', node: <Text dimColor>{' │ '} iter: {iteration}</Text> });
  }

  // Running: show per-turn elapsed + cumulative total
  if (elapsed > 0 && activity !== 'idle') {
    const total = totalElapsed + elapsed;
    parts.push({ key: 'elapsed', node: <Text dimColor>{' │ '} {elapsed}s/{total}s</Text> });
  }

  // Idle: show total time and token usage
  if (activity === 'idle') {
    if (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0) {
      const inK = tokenUsage.inputTokens >= 1000 ? `${(tokenUsage.inputTokens / 1000).toFixed(1)}k` : String(tokenUsage.inputTokens);
      const outK = tokenUsage.outputTokens >= 1000 ? `${(tokenUsage.outputTokens / 1000).toFixed(1)}k` : String(tokenUsage.outputTokens);
      parts.push({ key: 'tokens', node: <Text dimColor>{' │ '} {inK}+{outK} tokens</Text> });
    }
    if (totalElapsed > 0) {
      parts.push({ key: 'total', node: <Text dimColor>{' │ '} {totalElapsed}s</Text> });
    }
  }

  return <Box>{parts.map((p) => <Box key={p.key}>{p.node}</Box>)}</Box>;
}

export function InputArea({
  onSubmit,
  isRunning,
  onAbort,
  onForceExit,
  onOpenPalette,
  onPaletteNavigate,
  onPaletteSelect,
  onPaletteClose,
  onPaletteFilterChange,
  overlayActive = false,
  paletteOpen = false,
  store,
  model,
  injectedValue,
}: InputAreaProps) {
  const [value, setValue] = useState('');
  const injectedRef = useRef<string>('');

  // Inject value from external source (e.g. skill selection from palette)
  useEffect(() => {
    if (injectedValue !== undefined && injectedValue !== injectedRef.current) {
      injectedRef.current = injectedValue;
      setValue(injectedValue);
    }
  }, [injectedValue]);
  const [status, setStatus] = useState<'idle' | 'running' | 'interrupting'>(
    isRunning ? 'running' : 'idle',
  );
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);

  // Subscribe to store state for status bar display
  const tokenUsage = useSyncExternalStore(
    useCallback((listener) => store.select(selectTokenUsage).subscribe(listener), [store]),
    useCallback(() => store.select(selectTokenUsage).get(), [store]),
  );

  const iteration = useSyncExternalStore(
    useCallback((listener) => store.select(selectIteration).subscribe(listener), [store]),
    useCallback(() => store.select(selectIteration).get(), [store]),
  );

  const elapsed = useSyncExternalStore(
    useCallback((listener) => store.select(selectElapsed).subscribe(listener), [store]),
    useCallback(() => store.select(selectElapsed).get(), [store]),
  );

  const totalElapsed = useSyncExternalStore(
    useCallback((listener) => store.select(selectTotalElapsed).subscribe(listener), [store]),
    useCallback(() => store.select(selectTotalElapsed).get(), [store]),
  );

  const toolCalls = useSyncExternalStore(
    useCallback((listener) => store.select(selectToolCalls).subscribe(listener), [store]),
    useCallback(() => store.select(selectToolCalls).get(), [store]),
  );

  // Sync status with isRunning prop
  useEffect(() => {
    if (isRunning && status === 'idle') {
      setStatus('running');
    } else if (!isRunning && status === 'running') {
      setStatus('idle');
    } else if (!isRunning && status === 'interrupting') {
      setStatus('idle');
    }
  }, [isRunning, status]);

  useInput((input, key) => {
    // Non-palette overlays (e.g. session picker) still block input
    if (overlayActive && !paletteOpen) return;

    // --- Palette mode: input is the palette filter ---
    if (paletteOpen) {
      if (key.escape) {
        setValue('');
        onPaletteClose?.();
        return;
      }
      if (key.return && !key.shift) {
        onPaletteSelect?.();
        return;
      }
      if (key.upArrow) {
        onPaletteNavigate?.('up');
        return;
      }
      if (key.downArrow) {
        onPaletteNavigate?.('down');
        return;
      }
      if (key.backspace || key.delete) {
        const next = value.slice(0, -1);
        if (next === '' || next === '/') {
          setValue('');
          onPaletteClose?.();
        } else {
          setValue(next);
          onPaletteFilterChange?.(next.startsWith('/') ? next.slice(1) : next);
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const next = value + input;
        setValue(next);
        onPaletteFilterChange?.(next.startsWith('/') ? next.slice(1) : next);
      }
      return;
    }

    // --- Normal input mode ---

    if (input === 'k' && key.ctrl) {
      onOpenPalette?.();
      return;
    }

    if (input === 'c' && key.ctrl) {
      const action = resolveCtrlCAction(status, value);
      switch (action) {
        case 'clear':
          setValue('');
          historyIndexRef.current = -1;
          break;
        case 'exit':
          onForceExit?.();
          break;
        case 'abort':
          setStatus('interrupting');
          onAbort?.();
          break;
        case 'force-exit':
          onForceExit?.();
          break;
      }
      return;
    }

    if (key.return && !key.shift) {
      const trimmed = value.trim();
      if (trimmed) {
        historyRef.current = pushHistory(historyRef.current, trimmed);
        historyIndexRef.current = -1;
        onSubmit(trimmed);
        setValue('');
      }
      return;
    }

    if (key.return && key.shift) {
      setValue((prev) => prev + '\n');
      return;
    }

    if (input === 'e' && key.ctrl) {
      const content = openInEditor(value);
      if (content !== null) {
        const trimmed = content.trim();
        if (trimmed) {
          historyRef.current = pushHistory(historyRef.current, trimmed);
          historyIndexRef.current = -1;
          onSubmit(trimmed);
          setValue('');
        } else {
          setValue('');
        }
      }
      return;
    }

    if (key.backspace || key.delete) {
      setValue((prev) => handleBackspace(prev));
      return;
    }

    if (key.upArrow) {
      const cursor = getCursorPosition(value);
      if (cursor.row === 0 && cursor.col === 0) {
        const result = navigateHistory(historyRef.current, historyIndexRef.current, 'up');
        historyRef.current = result.history;
        historyIndexRef.current = result.historyIndex;
        setValue(result.value);
      }
      return;
    }

    if (key.downArrow) {
      const cursor = getCursorPosition(value);
      const lines = value.split('\n');
      const lastLine = lines[lines.length - 1];
      const atEnd = cursor.row === lines.length - 1 && cursor.col === lastLine.length;
      if (atEnd) {
        const result = navigateHistory(historyRef.current, historyIndexRef.current, 'down');
        historyRef.current = result.history;
        historyIndexRef.current = result.historyIndex;
        setValue(result.value);
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      if (input === '/' && value === '') {
        setValue('/');
        onOpenPalette?.();
        return;
      }
      setValue((prev) => prev + input);
    }
  });

  const activity = deriveActivity(status, toolCalls);
  const displayTotal = totalElapsed + (elapsed > 0 ? elapsed : 0);

  const prompt = isRunning ? 'Follow-up > ' : '> ';
  const lines = value.split('\n');

  return (
    <Box flexDirection="column">
      {/* Activity indicator line */}
      <Box>
        <ActivityIndicator activity={activity} model={model} iteration={iteration} elapsed={elapsed} totalElapsed={displayTotal} tokenUsage={tokenUsage} toolCalls={toolCalls} />
      </Box>

      {/* Separator */}
      <Box>
        <Text color={colors.border}>{'\u2500'.repeat(80)}</Text>
      </Box>

      {/* Input lines */}
      <Box flexDirection="column" paddingX={1}>
        {lines.map((line, i) => (
          <Box key={i}>
            {i === 0 && (
              <Text color={colors.prompt} bold>
                {prompt}
              </Text>
            )}
            {i > 0 && (
              <Text>
                {' '.repeat(prompt.length)}
              </Text>
            )}
            <Text>{line}</Text>
            {i === lines.length - 1 && <Text dimColor>_</Text>}
          </Box>
        ))}
        {lines.length === 0 && (
          <Box>
            <Text color="green" bold>
              {prompt}
            </Text>
            <Text dimColor>_</Text>
          </Box>
        )}

        {/* Help line */}
        <Text dimColor>
          Ctrl+K palette {' \u2502 '} Ctrl+E editor {' \u2502 '} Ctrl+C cancel
        </Text>
      </Box>
    </Box>
  );
}
