import type { AgentStatus, TokenUsage } from '@cortx/store';
import type { WebRuntimeSessionInfo } from '../bridge/event-bridge';
import { compactPath, compactSessionId, formatElapsed, formatTokenUsage, statusTone, surface } from '../design';

interface WorkspaceHeaderProps {
  status: AgentStatus;
  session: WebRuntimeSessionInfo | null;
  tokenUsage: TokenUsage;
  elapsed: number;
  iteration: number;
}

function HeaderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">{label}</div>
      <div className="truncate text-xs text-zinc-300">{value}</div>
    </div>
  );
}

export function WorkspaceHeader({ status, session, tokenUsage, elapsed, iteration }: WorkspaceHeaderProps) {
  const tone = statusTone(status);

  return (
    <header className={`flex min-h-16 items-center gap-4 border-b border-white/8 px-5 ${surface.softPanel}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${tone.dotClass} ${tone.busy ? 'animate-pulse' : ''}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${tone.textClass}`}>{tone.label}</span>
            {iteration > 0 && (
              <span className="rounded border border-white/8 bg-white/4 px-1.5 py-0.5 text-[10px] text-zinc-500">
                turn {iteration}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-zinc-500">
            {session ? `${session.model} · ${compactPath(session.workingDirectory)}` : 'No active runtime session'}
          </div>
        </div>
      </div>

      <div className="hidden min-w-0 grid-cols-3 gap-5 md:grid">
        <HeaderMetric label="Session" value={compactSessionId(session?.id, 14)} />
        <HeaderMetric label="Tokens" value={formatTokenUsage(tokenUsage)} />
        <HeaderMetric label="Elapsed" value={formatElapsed(elapsed)} />
      </div>
    </header>
  );
}
