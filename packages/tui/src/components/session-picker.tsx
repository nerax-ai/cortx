/**
 * Session picker overlay — arrow-key navigable session list.
 *
 * Shows past sessions with: timestamp, first user message, status indicator.
 * Arrow keys navigate, Enter selects, Escape closes.
 *
 * Pure helper functions are exported for testing.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SessionSummary } from '../plugins/session-plugin.js';

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Filter sessions by substring match against summary fields.
 * Case-insensitive comparison.
 */
export function filterSessions(
  sessions: SessionSummary[],
  filter: string,
): SessionSummary[] {
  if (!filter) return sessions;
  const lower = filter.toLowerCase();
  return sessions.filter(
    (s) =>
      s.lastUserMessage.toLowerCase().includes(lower) ||
      s.sessionId.toLowerCase().includes(lower) ||
      s.model.toLowerCase().includes(lower) ||
      s.status.toLowerCase().includes(lower),
  );
}

/**
 * Move the selection index within filtered sessions.
 * Wraps around at boundaries.
 */
export function moveSessionSelection(
  currentIndex: number,
  direction: 'up' | 'down',
  itemCount: number,
): number {
  if (itemCount === 0) return -1;
  if (direction === 'up') {
    return currentIndex <= 0 ? itemCount - 1 : currentIndex - 1;
  } else {
    return currentIndex >= itemCount - 1 ? 0 : currentIndex + 1;
  }
}

/**
 * Format a timestamp string to a shorter display form.
 */
export function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    const now = new Date();
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();

    if (isToday) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

/**
 * Truncate a string to maxLen, adding ellipsis if needed.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface SessionPickerProps {
  /** Available session summaries. */
  sessions: SessionSummary[];
  /** Called when user selects a session to restore. */
  onSelect: (session: SessionSummary) => void;
  /** Called when user dismisses the picker (Escape). */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Session picker overlay with fuzzy search.
 *
 * Captures keyboard input exclusively while open:
 *   - Type to filter sessions
 *   - Up/Down arrows to navigate
 *   - Enter to select session for restore
 *   - Escape to close
 *   - Backspace to delete filter character
 */
export function SessionPicker({
  sessions,
  onSelect,
  onClose,
}: SessionPickerProps) {
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = filterSessions(sessions, filter);

  // Keep selection within bounds when filter changes
  const safeIndex =
    filtered.length === 0
      ? -1
      : Math.min(selectedIndex, filtered.length - 1);

  useInput((input, key) => {
    // --- Escape: close ---
    if (key.escape) {
      onClose();
      return;
    }

    // --- Enter: select ---
    if (key.return) {
      if (filtered.length > 0 && safeIndex >= 0) {
        onSelect(filtered[safeIndex]);
      }
      return;
    }

    // --- Up arrow: navigate ---
    if (key.upArrow) {
      setSelectedIndex(moveSessionSelection(safeIndex, 'up', filtered.length));
      return;
    }

    // --- Down arrow: navigate ---
    if (key.downArrow) {
      setSelectedIndex(moveSessionSelection(safeIndex, 'down', filtered.length));
      return;
    }

    // --- Backspace: delete filter character ---
    if (key.backspace || key.delete) {
      setFilter((prev) => prev.slice(0, -1));
      return;
    }

    // --- Regular printable character: append to filter ---
    if (input && !key.ctrl && !key.meta) {
      setFilter((prev) => prev + input);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      {/* Header */}
      <Box>
        <Text bold color="yellow">
          {'Resume Session'}
        </Text>
      </Box>

      {/* Search input */}
      <Box marginTop={1}>
        <Text bold color="yellow">
          {'> '}
        </Text>
        <Text>{filter}</Text>
        <Text dimColor>_</Text>
      </Box>

      {/* Session list */}
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? (
          <Text dimColor>No sessions found</Text>
        ) : (
          filtered.map((session, i) => {
            const isSelected = i === safeIndex;
            const timeStr = formatTime(session.startTime);
            const statusColor = session.status === 'completed' ? 'green' : 'red';
            const statusLabel = session.status === 'completed' ? 'OK' : '!!';

            return (
              <Box key={session.sessionId}>
                {isSelected ? (
                  <Text bold color="yellow">
                    {'> '}
                  </Text>
                ) : (
                  <Text>{'  '}</Text>
                )}
                <Text color={statusColor}>
                  {`[${statusLabel}] `}
                </Text>
                <Text bold={isSelected} color={isSelected ? 'cyan' : undefined}>
                  {truncate(session.lastUserMessage, 40)}
                </Text>
                <Text dimColor>{` · ${timeStr}`}</Text>
              </Box>
            );
          })
        )}
      </Box>

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text dimColor>
          Enter= restore | Up/Down= navigate | Esc= close
        </Text>
      </Box>
    </Box>
  );
}
