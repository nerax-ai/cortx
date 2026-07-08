import { useState } from 'react';
import type { AgentStatus } from '@cortx/store';
import type { WebEventConnectionState, WebRuntimeSessionInfo } from '../bridge/event-bridge';
import { compactPath, statusTone, surface } from '../design';
import type { WorkspacePanelTab } from './InspectorPanel';

interface WorkspaceHeaderProps {
  status: AgentStatus;
  session: WebRuntimeSessionInfo | null;
  iteration: number;
  eventConnection: WebEventConnectionState;
  onRecoverEventStream: () => void | Promise<void>;
  panelOpen?: boolean;
  activePanel?: WorkspacePanelTab;
  onOpenPanel?: (tab: WorkspacePanelTab) => void;
  onClosePanel?: () => void;
}

const CONNECTION_LABELS: Record<WebEventConnectionState['phase'], string> = {
  connecting: 'Connecting',
  replaying: 'Replaying',
  live: 'Live',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  closed: 'Closed',
};

const CONNECTION_CLASSES: Record<WebEventConnectionState['phase'], string> = {
  connecting: 'border-sky-200 bg-sky-50 text-sky-700',
  replaying: 'border-amber-200 bg-amber-50 text-amber-700',
  live: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  reconnecting: 'border-amber-200 bg-amber-50 text-amber-700',
  disconnected: 'border-rose-200 bg-rose-50 text-rose-700',
  closed: 'border-zinc-200 bg-zinc-50 text-zinc-600',
};

function canRecoverEventStream(phase: WebEventConnectionState['phase']): boolean {
  return phase === 'reconnecting' || phase === 'disconnected' || phase === 'closed';
}

function EventConnectionPill({
  connection,
  onRecover,
}: {
  connection: WebEventConnectionState;
  onRecover: () => void | Promise<void>;
}) {
  const recoverable = canRecoverEventStream(connection.phase);
  const sequence = connection.lastSequence === undefined ? null : `event ${connection.lastSequence}`;

  return (
    <div className={`flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1 text-xs ${CONNECTION_CLASSES[connection.phase]}`}>
      <span>{CONNECTION_LABELS[connection.phase]}</span>
      {sequence && <span className="font-mono opacity-70">{sequence}</span>}
      {recoverable && (
        <button
          type="button"
          onClick={() => void onRecover()}
          className={`rounded border border-current/20 bg-white/70 px-1.5 py-0.5 text-[11px] font-medium hover:bg-white ${surface.focus}`}
        >
          Recover stream
        </button>
      )}
    </div>
  );
}

const PANEL_ITEMS: Array<{ value: WorkspacePanelTab; label: string }> = [
  { value: 'activity', label: 'Activity' },
  { value: 'review', label: 'Review' },
  { value: 'browser', label: 'Browser' },
];

function PanelLauncher({
  panelOpen,
  activePanel,
  onOpenPanel,
  onClosePanel,
}: {
  panelOpen: boolean;
  activePanel: WorkspacePanelTab;
  onOpenPanel: (tab: WorkspacePanelTab) => void;
  onClosePanel: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Open workspace panels"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700 hover:bg-zinc-50 ${surface.focus}`}
      >
        <span>{panelOpen ? PANEL_ITEMS.find((item) => item.value === activePanel)?.label ?? 'Panels' : 'Panels'}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 text-zinc-400">
          <path d="M4.5 6.25 8 9.75l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-200/70">
          {PANEL_ITEMS.map((item) => {
            const selected = panelOpen && activePanel === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => {
                  onOpenPanel(item.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs ${
                  selected ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-700 hover:bg-zinc-50'
                } ${surface.focus}`}
              >
                <span>{item.label}</span>
                {selected && <span className="text-zinc-400">open</span>}
              </button>
            );
          })}
          {panelOpen && (
            <button
              type="button"
              onClick={() => {
                onClosePanel();
                setOpen(false);
              }}
              className={`mt-1 flex w-full items-center rounded-lg border-t border-zinc-100 px-2.5 py-2 text-left text-xs text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 ${surface.focus}`}
            >
              Hide panel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkspaceHeader({
  status,
  session,
  iteration,
  eventConnection,
  onRecoverEventStream,
  panelOpen = false,
  activePanel = 'activity',
  onOpenPanel,
  onClosePanel,
}: WorkspaceHeaderProps) {
  const tone = statusTone(status);

  return (
    <header className="flex min-h-14 items-center gap-4 border-b border-zinc-200 bg-white px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${tone.dotClass} ${tone.busy ? 'animate-pulse' : ''}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${tone.textClass}`}>{tone.label}</span>
            {iteration > 0 && (
              <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-500">
                turn {iteration}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-zinc-500">
            {session ? `${session.model} · ${compactPath(session.workingDirectory)}` : 'No active runtime session'}
          </div>
        </div>
      </div>

      <EventConnectionPill connection={eventConnection} onRecover={onRecoverEventStream} />
      {onOpenPanel && onClosePanel && (
        <PanelLauncher
          panelOpen={panelOpen}
          activePanel={activePanel}
          onOpenPanel={onOpenPanel}
          onClosePanel={onClosePanel}
        />
      )}
    </header>
  );
}
