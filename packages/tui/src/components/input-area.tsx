import { useState, useRef, useEffect, useSyncExternalStore, useCallback } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TuiStore } from '../store.js';
import type { TuiState } from '../types/tui-state.js';
import { colors } from '../theme.js';
import { headerSegments, statusBadge } from './session-header.js';

// Stable module-level selectors to avoid Map key fragmentation in TuiStore
const selectTokenUsage = (s: TuiState) => s.tokenUsage;
const selectIteration = (s: TuiState) => s.iteration;
const selectElapsed = (s: TuiState) => s.elapsed;
const selectTotalElapsed = (s: TuiState) => s.totalElapsed;
const selectToolCalls = (s: TuiState) => s.toolCalls;
const selectStatus = (s: TuiState) => s.status;
const selectSessionId = (s: TuiState) => s.sessionId;

export interface InputAreaProps {
  onSubmit: (value: string) => void;
  onSteer?: (value: string) => void;
  isRunning: boolean;
  onAbort?: () => void;
  onForceExit?: () => void;
  onOpenPalette?: () => void;
  onPaletteNavigate?: (dir: 'up' | 'down') => void;
  onPaletteSelect?: () => boolean;
  onPaletteClose?: () => void;
  onPaletteFilterChange?: (filter: string) => void;
  overlayActive?: boolean;
  paletteOpen?: boolean;
  store: TuiStore;
  model: string;
  cwd: string;
  registryReady?: boolean;
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

export function separator(width: number): string {
  return '─'.repeat(Math.max(24, Math.min(120, width)));
}

export function composerBorderColor(status: string, paletteOpen: boolean): string {
  if (paletteOpen) return colors.borderActive;
  if (status === 'error') return colors.activityError;
  if (status === 'interrupting') return colors.activityInterrupt;
  if (status === 'running' || status === 'awaiting_user') return colors.borderActive;
  return colors.border;
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

export function helpText(isRunning: boolean, paletteOpen: boolean, width = 80): string {
  if (paletteOpen) return 'Enter select | Esc close | type to filter';
  if (isRunning) return 'Enter follow-up  ·  Ctrl+S steer  ·  Ctrl+C interrupt';
  if (width < 88) return 'Enter send  ·  Ctrl+S steer  ·  / commands  ·  Ctrl+C exit';
  return 'Enter send  ·  Shift+Enter newline  ·  Ctrl+S steer  ·  Ctrl+E editor  ·  / commands';
}

export function visibleInputLines(value: string, maxLines = 4): { lines: string[]; hiddenCount: number } {
  const lines = value.split('\n');
  if (lines.length <= maxLines) return { lines, hiddenCount: 0 };
  return {
    lines: lines.slice(lines.length - maxLines),
    hiddenCount: lines.length - maxLines,
  };
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
type InputMode = 'chat' | 'steer';

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

export function activityLabel(
  activity: ActivityState,
  {
    toolCalls,
  }: {
    toolCalls: Map<string, { status: string; toolName: string }>;
  },
): string {
  switch (activity) {
    case 'thinking':
      return 'thinking';
    case 'executing': {
      const latestTool = [...toolCalls.values()].find((e) => e.status === 'pending');
      const name = latestTool?.toolName ?? 'tool';
      return `running ${name}`;
    }
    case 'interrupting':
      return 'interrupting';
    case 'error':
      return 'error';
    default:
      return 'ready';
  }
}

function activityColor(activity: ActivityState, fallback: string): string {
  switch (activity) {
    case 'thinking':
      return colors.activityThinking;
    case 'executing':
      return colors.activityExecuting;
    case 'interrupting':
      return colors.activityInterrupt;
    case 'error':
      return colors.activityError;
    default:
      return fallback;
  }
}

export function InputArea({
  onSubmit,
  onSteer,
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
  cwd,
  registryReady = true,
  injectedValue,
}: InputAreaProps) {
  const { columns } = useWindowSize();
  const [value, setValue] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('chat');
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

  const storeStatus = useSyncExternalStore(
    useCallback((listener) => store.select(selectStatus).subscribe(listener), [store]),
    useCallback(() => store.select(selectStatus).get(), [store]),
  );

  const sessionId = useSyncExternalStore(
    useCallback((listener) => store.select(selectSessionId).subscribe(listener), [store]),
    useCallback(() => store.select(selectSessionId).get(), [store]),
  );

  usePaste(
    (text) => {
      if (overlayActive) return;
      setValue((prev) => insertText(prev, text));
    },
    { isActive: !paletteOpen },
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
        const handled = onPaletteSelect?.() ?? false;
        if (handled) {
          // Palette item was selected — clear the typed filter text
          setValue('');
        } else {
          // No matching palette item — submit the typed text as a regular command
          const trimmed = value.trim();
          if (trimmed) {
            onSubmit(trimmed);
          }
          setValue('');
        }
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

    if (input === 's' && key.ctrl) {
      setInputMode((prev) => (prev === 'steer' ? 'chat' : 'steer'));
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
        if (inputMode === 'steer') {
          onSteer?.(trimmed);
          setInputMode('chat');
        } else {
          onSubmit(trimmed);
        }
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
          if (inputMode === 'steer') {
            onSteer?.(trimmed);
            setInputMode('chat');
          } else {
            onSubmit(trimmed);
          }
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
      const result = navigateHistory(historyRef.current, historyIndexRef.current, 'up');
      historyRef.current = result.history;
      historyIndexRef.current = result.historyIndex;
      setValue(result.value);
      return;
    }

    if (key.downArrow) {
      const result = navigateHistory(historyRef.current, historyIndexRef.current, 'down');
      historyRef.current = result.history;
      historyIndexRef.current = result.historyIndex;
      setValue(result.value);
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

  const effectiveStatus = status === 'interrupting' ? 'interrupting' : storeStatus;
  const activity = deriveActivity(effectiveStatus, toolCalls);

  const prompt = inputMode === 'steer' ? 'steer' : isRunning ? 'follow-up' : 'cortx';
  const { lines, hiddenCount } = visibleInputLines(value, 4);
  const statusSummary = statusBadge(effectiveStatus, registryReady);
  const activitySummary = effectiveStatus === 'running'
    ? {
      label: activityLabel(activity, { toolCalls }),
      color: activityColor(activity, statusSummary.color),
    }
    : statusSummary;
  const contextSegments = headerSegments({
    model,
    cwd,
    sessionId,
    iteration,
    tokenUsage,
    totalElapsed: totalElapsed + (effectiveStatus === 'running' ? elapsed : 0),
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor={inputMode === 'steer' ? colors.activityThinking : composerBorderColor(effectiveStatus, paletteOpen)}
        paddingX={1}
        flexDirection="column"
      >
        <Box>
          <Text bold color="cyan">Cortx</Text>
          <Text dimColor>{' · '}</Text>
          <Text color={activitySummary.color} bold>{activitySummary.label}</Text>
          {contextSegments.length > 0 && (
            <Text dimColor>{' · '}{contextSegments.join(' · ')}</Text>
          )}
        </Box>
        {hiddenCount > 0 && (
          <Box>
            <Text dimColor>{`  ... ${hiddenCount} earlier input line${hiddenCount === 1 ? '' : 's'}`}</Text>
          </Box>
        )}
        {lines.map((line, i) => (
          <Box key={i}>
            {i === 0 && hiddenCount === 0 && (
              <>
                <Text color={colors.prompt} bold>{prompt}</Text>
                <Text dimColor>{' › '}</Text>
              </>
            )}
            {(i > 0 || hiddenCount > 0) && (
              <Text dimColor>{' '.repeat(prompt.length + 3)}</Text>
            )}
            <Text>{line}</Text>
            {i === lines.length - 1 && <Text dimColor>_</Text>}
          </Box>
        ))}
        {lines.length === 0 && (
          <Box>
            <Text color={colors.prompt} bold>{prompt}</Text>
            <Text dimColor>{' › '}</Text>
            <Text dimColor>_</Text>
          </Box>
        )}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{helpText(isRunning, paletteOpen, columns)}</Text>
      </Box>
    </Box>
  );
}
