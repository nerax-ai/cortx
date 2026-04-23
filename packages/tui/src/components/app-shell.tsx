import { useState, useSyncExternalStore, useCallback, useMemo } from 'react';
import { Box, useInput, useWindowSize } from 'ink';
import { OutputRegion } from './output-region.js';
import { InputArea } from './input-area.js';
import { CommandPalette, buildItems, filterItems, moveSelection } from './command-palette.js';
import { SessionPicker } from './session-picker.js';
import type { TuiStore } from '../store.js';
import type { TuiRegistry } from '../tui-registry.js';
import type { SessionSummary } from '../plugins/session-plugin.js';
import type { SkillItem } from '../plugins/skill-plugin.js';

export interface AppShellProps {
  store: TuiStore;
  registry: TuiRegistry;
  model: string;
  cwd: string;
  skills: SkillItem[];
  onSubmit: (value: string) => void;
  onAbort?: () => void;
  onForceExit?: () => void;
  sessionPickerOpen?: boolean;
  sessionList?: SessionSummary[];
  onSessionSelect?: (session: SessionSummary) => void;
  onSessionPickerClose?: () => void;
}

export function AppShell({
  store,
  registry,
  model,
  cwd,
  skills,
  onSubmit,
  onAbort,
  onForceExit,
  sessionPickerOpen = false,
  sessionList = [],
  onSessionSelect,
  onSessionPickerClose,
}: AppShellProps) {
  const status = useSyncExternalStore(
    useCallback((listener) => store.select((s) => s.status).subscribe(listener), [store]),
    useCallback(() => store.select((s) => s.status).get(), [store]),
  );

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSelectedIndex, setPaletteSelectedIndex] = useState(0);
  const [paletteFilter, setPaletteFilter] = useState('');
  const [injectedValue, setInjectedValue] = useState<string | undefined>(undefined);
  const anyOverlayActive = paletteOpen || sessionPickerOpen;
  const { rows } = useWindowSize();
  const inputAreaRows = 5;
  const viewportHeight = Math.max(3, rows - inputAreaRows);

  const paletteItems = useMemo(
    () => buildItems(registry.getCommands(), skills),
    [registry, skills],
  );

  const filteredPaletteItems = useMemo(
    () => filterItems(paletteItems, paletteFilter),
    [paletteItems, paletteFilter],
  );

  const safePaletteIndex = filteredPaletteItems.length === 0
    ? -1
    : Math.min(paletteSelectedIndex, filteredPaletteItems.length - 1);

  const handlePaletteNavigate = useCallback((dir: 'up' | 'down') => {
    setPaletteSelectedIndex((prev) => {
      const filtered = filterItems(paletteItems, paletteFilter);
      return moveSelection(prev, dir, filtered.length);
    });
  }, [paletteItems, paletteFilter]);

  const handlePaletteSelect = useCallback(() => {
    const filtered = filterItems(paletteItems, paletteFilter);
    if (filtered.length === 0) return;
    const idx = Math.min(paletteSelectedIndex, filtered.length - 1);
    const selected = filtered[idx];
    setPaletteOpen(false);
    setPaletteSelectedIndex(0);
    setPaletteFilter('');
    if (selected.type === 'skill') {
      setInjectedValue(`${selected.name} `);
    } else {
      const cmd = registry.getCommands().find((c) => c.name === selected.name);
      if (cmd) registry.executeCommand(cmd.name, '', { args: '', abort: () => {} });
    }
  }, [paletteItems, paletteFilter, paletteSelectedIndex, registry]);

  const handlePaletteClose = useCallback(() => {
    setPaletteOpen(false);
    setPaletteSelectedIndex(0);
    setPaletteFilter('');
  }, []);

  // Scroll key handling at the shell level
  useInput((input, key) => {
    if (anyOverlayActive) return;

    if (key.pageUp) {
      store.scrollUp(viewportHeight);
      return;
    }
    if (key.pageDown) {
      store.scrollDown(viewportHeight);
      return;
    }
    if (input === 'G' && key.shift && !key.ctrl) {
      store.scrollToBottom();
      return;
    }
    if (input === 'J' && key.shift && !key.ctrl) {
      store.scrollDown(1);
      return;
    }
    if (input === 'K' && key.shift && !key.ctrl) {
      store.scrollUp(1);
      return;
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <OutputRegion store={store} height={viewportHeight} />

      <InputArea
        onSubmit={onSubmit}
        isRunning={status === 'running'}
        onAbort={onAbort}
        onForceExit={onForceExit}
        onOpenPalette={() => {
          setPaletteOpen(true);
          setPaletteSelectedIndex(0);
          setPaletteFilter('');
        }}
        onPaletteNavigate={handlePaletteNavigate}
        onPaletteSelect={handlePaletteSelect}
        onPaletteClose={handlePaletteClose}
        onPaletteFilterChange={(f) => setPaletteFilter(f)}
        overlayActive={sessionPickerOpen}
        paletteOpen={paletteOpen}
        store={store}
        model={model}
        injectedValue={injectedValue}
      />

      {paletteOpen && (
        <Box flexDirection="column" position="absolute" bottom={inputAreaRows} left={0} right={0}>
          <CommandPalette
            items={paletteItems}
            filter={paletteFilter}
            selectedIndex={paletteSelectedIndex}
            maxHeight={viewportHeight}
          />
        </Box>
      )}

      {sessionPickerOpen && onSessionSelect && onSessionPickerClose && (
        <Box flexDirection="column" position="absolute" width="100%" height="100%">
          <SessionPicker
            sessions={sessionList}
            onSelect={onSessionSelect}
            onClose={onSessionPickerClose}
          />
        </Box>
      )}
    </Box>
  );
}
