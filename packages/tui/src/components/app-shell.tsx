import { useState, useSyncExternalStore, useCallback, useMemo } from 'react';
import { Box, useInput } from 'ink';
import { OutputRegion } from './output-region.js';
import { InputArea } from './input-area.js';
import { ToolRegion } from './tool-region.js';
import { AgentViewer } from './agent-viewer.js';
import { CommandPalette, buildItems, filterItems, moveSelection } from './command-palette.js';
import { SessionPicker } from './session-picker.js';
import type { TuiStore } from '../store.js';
import type { TuiState } from '../types/tui-state.js';
import type { TuiRegistry } from '../tui-registry.js';
import type { SessionSummary } from '../plugins/session-plugin.js';
import type { SkillItem } from '../plugins/skill-plugin.js';
import type { SubAgentSessionStore } from '@cortx/core';

const selectStatus = (s: TuiState) => s.status;
const selectActiveAgentView = (s: TuiState) => s.activeAgentView;

export interface AppShellProps {
  store: TuiStore;
  registry: TuiRegistry;
  registryReady?: boolean;
  model: string;
  cwd: string;
  skills: SkillItem[];
  agentSessionsStore: SubAgentSessionStore;
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
  registryReady = true,
  model,
  skills,
  agentSessionsStore,
  onSubmit,
  onAbort,
  onForceExit,
  sessionPickerOpen = false,
  sessionList = [],
  onSessionSelect,
  onSessionPickerClose,
}: AppShellProps) {
  const status = useSyncExternalStore(
    useCallback((listener) => store.select(selectStatus).subscribe(listener), [store]),
    useCallback(() => store.select(selectStatus).get(), [store]),
  );

  const activeAgentView = useSyncExternalStore(
    useCallback((listener) => store.select(selectActiveAgentView).subscribe(listener), [store]),
    useCallback(() => store.select(selectActiveAgentView).get(), [store]),
  );

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSelectedIndex, setPaletteSelectedIndex] = useState(0);
  const [paletteFilter, setPaletteFilter] = useState('');
  const [injectedValue, setInjectedValue] = useState<string | undefined>(undefined);
  const [toolExpanded, setToolExpanded] = useState(false);
  const anyOverlayActive = paletteOpen || sessionPickerOpen;

  const paletteItems = useMemo(
    () => buildItems(registry.getCommands(), skills),
    [registry, registryReady, skills],
  );

  const filteredPaletteItems = useMemo(
    () => filterItems(paletteItems, paletteFilter),
    [paletteItems, paletteFilter],
  );

  const handlePaletteNavigate = useCallback((dir: 'up' | 'down') => {
    setPaletteSelectedIndex((prev) => moveSelection(prev, dir, filteredPaletteItems.length));
  }, [filteredPaletteItems]);

  const handlePaletteSelect = useCallback((): boolean => {
    if (filteredPaletteItems.length === 0) {
      setPaletteOpen(false);
      setPaletteSelectedIndex(0);
      setPaletteFilter('');
      return false;
    }
    const idx = Math.min(paletteSelectedIndex, filteredPaletteItems.length - 1);
    const selected = filteredPaletteItems[idx];
    setPaletteOpen(false);
    setPaletteSelectedIndex(0);
    setPaletteFilter('');
    if (selected.type === 'skill') {
      setInjectedValue(`${selected.name} `);
    } else {
      const cmd = registry.getCommands().find((c) => c.name === selected.name);
      if (cmd) registry.executeCommand(cmd.name, '', { args: '', abort: () => {} });
    }
    return true;
  }, [filteredPaletteItems, paletteSelectedIndex, registry]);

  const handlePaletteFilterChange = useCallback((filter: string) => {
    setPaletteFilter(filter);
  }, []);

  const handlePaletteClose = useCallback(() => {
    setPaletteOpen(false);
    setPaletteSelectedIndex(0);
    setPaletteFilter('');
  }, []);

  useInput((input, key) => {
    if (anyOverlayActive) return;
    if (input === 'T' && key.shift && !key.ctrl) {
      setToolExpanded((prev) => !prev);
    }
    // 'a' key opens agent viewer for the first completed agent in expanded tool region
    if (input === 'a' && !key.ctrl && toolExpanded && status === 'idle') {
      const toolCalls = store.getState().toolCalls;
      const agentSessions = store.getState().agentSessions;
      for (const [id, entry] of toolCalls) {
        if (entry.toolName === 'agent' && entry.status === 'complete' && agentSessions.has(id)) {
          store.setActiveAgentView(id);
          return;
        }
      }
    }
  });

  // Session picker overlay
  if (sessionPickerOpen && onSessionSelect && onSessionPickerClose) {
    return (
      <SessionPicker
        sessions={sessionList}
        onSelect={onSessionSelect}
        onClose={onSessionPickerClose}
      />
    );
  }

  // Agent viewer mode
  if (activeAgentView) {
    return (
      <Box flexDirection="column">
        <AgentViewer
          store={store}
          agentSessionsStore={agentSessionsStore}
          onExit={() => store.setActiveAgentView(null)}
        />
        <InputArea
          onSubmit={onSubmit}
          isRunning={status === 'running'}
          onAbort={onAbort}
          onForceExit={onForceExit}
          onOpenPalette={() => { setPaletteOpen(true); setPaletteSelectedIndex(0); setPaletteFilter(''); }}
          onPaletteNavigate={handlePaletteNavigate}
          onPaletteSelect={handlePaletteSelect}
          onPaletteClose={handlePaletteClose}
          onPaletteFilterChange={handlePaletteFilterChange}
          overlayActive={sessionPickerOpen}
          paletteOpen={paletteOpen}
          store={store}
          model={model}
          injectedValue={injectedValue}
        />
      </Box>
    );
  }

  // Normal mode: streaming content + input area
  return (
    <Box flexDirection="column">
      <OutputRegion store={store} />
      <ToolRegion store={store} collapsed={!toolExpanded} onViewAgent={(id) => store.setActiveAgentView(id)} />
      <InputArea
        onSubmit={onSubmit}
        isRunning={status === 'running'}
        onAbort={onAbort}
        onForceExit={onForceExit}
        onOpenPalette={() => { setPaletteOpen(true); setPaletteSelectedIndex(0); setPaletteFilter(''); }}
        onPaletteNavigate={handlePaletteNavigate}
        onPaletteSelect={handlePaletteSelect}
        onPaletteClose={handlePaletteClose}
        onPaletteFilterChange={handlePaletteFilterChange}
        overlayActive={sessionPickerOpen}
        paletteOpen={paletteOpen}
        store={store}
        model={model}
        injectedValue={injectedValue}
      />

      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          filter={paletteFilter}
          selectedIndex={paletteSelectedIndex}
        />
      )}
    </Box>
  );
}
