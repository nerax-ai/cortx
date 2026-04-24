import { useSyncExternalStore, useCallback } from 'react';
import { Box, Text } from 'ink';
import type { TuiStore } from '../store.js';
import type { TuiState } from '../types/tui-state.js';
import { Markdown } from './markdown.js';
import { colors } from '../theme.js';

const selectMessages = (s: TuiState) => s.messages;

export interface OutputRegionProps {
  store: TuiStore;
}

/**
 * OutputRegion — renders current streaming content only.
 *
 * Completed turns are written to the terminal via console.log (patched by Ink
 * to appear above the Ink frame). This component only shows the text currently
 * being streamed (currentText) and the thinking indicator (currentThinking).
 * Active tool calls are shown in the ToolRegion component.
 */
export function OutputRegion({ store }: OutputRegionProps) {
  const messages = useSyncExternalStore(
    useCallback((listener) => store.select(selectMessages).subscribe(listener), [store]),
    useCallback(() => store.select(selectMessages).get(), [store]),
  );

  const { currentText, currentThinking } = messages;

  if (!currentText && !currentThinking) return null;

  return (
    <Box flexDirection="column">
      {currentThinking && (
        <Box>
          <Text dimColor color={colors.thinking}>{'▶'} Thinking...</Text>
        </Box>
      )}
      {currentText && <Markdown text={currentText} />}
    </Box>
  );
}
