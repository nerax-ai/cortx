import type { AgentStatus, TokenUsage } from '@cortx/store';
import type { WebEventConnectionState, WebRuntimeSessionInfo } from '../bridge/event-bridge';
import { compactPath, compactSessionId, formatElapsed, formatTokenUsage, statusTone, surface } from '../design';

interface WorkspaceHeaderProps {
  status: AgentStatus;
  session: WebRuntimeSessionInfo | null;
  tokenUsage: TokenUsage;
  elapsed: number;
  iteration: number;
  eventConnection: WebEventConnectionState;
  onRecoverEventStream: () => void | Promise<void>;
}

function HeaderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-400">{label}</div>
      <div className="truncate text-xs text-zinc-700">{value}</div>
    </div>
  );
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

export function WorkspaceHeader({
  status,
  session,
  tokenUsage,
  elapsed,
  iteration,
  eventConnection,
  onRecoverEventStream,
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

      <div className="hidden min-w-0 grid-cols-3 gap-5 md:grid">
        <HeaderMetric label="Session" value={compactSessionId(session?.id, 14)} />
        <HeaderMetric label="Session Tokens" value={formatTokenUsage(tokenUsage)} />
        <HeaderMetric label="Elapsed" value={formatElapsed(elapsed)} />
      </div>
    </header>
  );
}
