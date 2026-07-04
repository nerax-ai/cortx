import type { AgentStatus, TokenUsage } from '@cortx/store';
import type { WebRuntimeSessionInfo } from '../bridge/event-bridge';
import { compactPath, compactSessionId, formatElapsed, formatTokenUsage, statusTone, surface } from '../design';

interface SessionSidebarProps {
  status: AgentStatus;
  session: WebRuntimeSessionInfo | null;
  tokenUsage: TokenUsage;
  elapsed: number;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-zinc-600">{label}</span>
      <span className="min-w-0 truncate text-right text-zinc-300">{value}</span>
    </div>
  );
}

export function SessionSidebar({ status, session, tokenUsage, elapsed }: SessionSidebarProps) {
  const tone = statusTone(status);

  return (
    <aside className={`flex min-h-0 flex-col gap-4 border-r border-white/8 p-4 ${surface.softPanel}`}>
      <div>
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md border border-white/10 bg-white/6 text-sm font-semibold text-zinc-100">
            Cx
          </div>
          <div>
            <div className="text-sm font-semibold text-zinc-100">Cortx</div>
            <div className="text-xs text-zinc-500">Remote agent workspace</div>
          </div>
        </div>
      </div>

      <section className={`rounded-lg p-3 ${surface.panel}`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-zinc-300">Active Session</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone.badgeClass}`}>{tone.label}</span>
        </div>
        <div className="space-y-2">
          <DetailRow label="Model" value={session?.model ?? 'not connected'} />
          <DetailRow label="Workspace" value={session ? compactPath(session.workingDirectory) : '-'} />
          <DetailRow label="Session" value={compactSessionId(session?.id, 13)} />
          <DetailRow label="Tools" value={session?.toolMode ?? '-'} />
          <DetailRow label="Approval" value={session?.approvalMode ?? '-'} />
        </div>
      </section>

      <section className={`rounded-lg p-3 ${surface.panel}`}>
        <div className="mb-3 text-xs font-medium text-zinc-300">Run Facts</div>
        <div className="space-y-2">
          <DetailRow label="Tokens" value={formatTokenUsage(tokenUsage)} />
          <DetailRow label="Elapsed" value={formatElapsed(elapsed)} />
          <DetailRow label="Events" value={String(session?.eventCount ?? 0)} />
        </div>
      </section>

      <section className="min-h-0 flex-1">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-300">Sessions</span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-700">soon</span>
        </div>
        <div className="rounded-lg border border-dashed border-white/8 bg-black/10 p-3 text-xs leading-relaxed text-zinc-600">
          Multi-session history will land here once server-side session listing and replay are productized.
        </div>
      </section>
    </aside>
  );
}
