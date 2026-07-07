import type { ToolCallEntry, AgentSessionSummary } from '@cortx/store';
import { surface } from '../design';
import { ToolCard } from './ToolCard';

interface ToolRegionProps {
  toolCalls: Map<string, ToolCallEntry>;
  agentSessions: Map<string, AgentSessionSummary>;
  maxItems?: number;
}

export function SubAgentCard({ session }: { session: AgentSessionSummary }) {
  const statusClass =
    session.status === 'running'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : session.status === 'error'
        ? 'border-rose-200 bg-rose-50 text-rose-700'
        : 'border-zinc-200 bg-zinc-50 text-zinc-600';

  return (
    <div className={`rounded-lg px-3 py-2 text-sm ${surface.panel}`}>
      <div className="flex items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${statusClass}`}>{session.status}</span>
        <span className="text-xs font-medium text-zinc-900">Sub-agent</span>
        {session.isBackground && (
          <span className="rounded border border-zinc-200 px-1 text-[10px] text-zinc-500">background</span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{session.description}</span>
      </div>
      {(session.progress || session.iterations > 0) && (
        <div className="mt-2 flex gap-3 pl-1 text-xs text-zinc-600">
          {session.iterations > 0 && <span>{session.iterations} iters</span>}
          {session.toolCallCount > 0 && <span>{session.toolCallCount} tools</span>}
          {session.progress && <span className="min-w-0 flex-1 truncate">{session.progress}</span>}
        </div>
      )}
    </div>
  );
}

export function ToolRegion({ toolCalls, agentSessions, maxItems }: ToolRegionProps) {
  if (toolCalls.size === 0 && agentSessions.size === 0) return null;

  const toolEntries = Array.from(toolCalls.entries());
  const subAgents = Array.from(agentSessions.values());
  const combined = [
    ...toolEntries.map(([id, entry]) => ({ kind: 'tool' as const, id, entry })),
    ...subAgents.map((session) => ({ kind: 'agent' as const, id: session.toolCallId, session })),
  ];
  const hiddenCount = maxItems ? Math.max(0, combined.length - maxItems) : 0;
  const visible = hiddenCount > 0 && maxItems !== undefined ? combined.slice(-maxItems) : combined;

  return (
    <div className="space-y-2">
      {hiddenCount > 0 && (
        <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-500">
          Showing latest {visible.length} of {combined.length}
        </div>
      )}
      {visible.map((item) =>
        item.kind === 'tool' ? (
          <ToolCard key={item.id} entry={item.entry} />
        ) : (
          <SubAgentCard key={item.id} session={item.session} />
        ),
      )}
    </div>
  );
}
