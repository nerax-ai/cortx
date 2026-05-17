import type { ToolCallEntry, AgentSessionSummary } from '@cortx/store';
import { ToolCard } from './ToolCard';

interface ToolRegionProps {
  toolCalls: Map<string, ToolCallEntry>;
  agentSessions: Map<string, AgentSessionSummary>;
}

function SubAgentCard({ session }: { session: AgentSessionSummary }) {
  const statusColor = session.status === 'running'
    ? 'text-blue-400'
    : session.status === 'error'
      ? 'text-red-400'
      : 'text-green-400';

  const statusIcon = session.status === 'running' ? '⟳' : session.status === 'error' ? '✗' : '✓';

  return (
    <div className="bg-gray-900/60 border border-gray-800/40 rounded-lg px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className={`${statusColor} ${session.status === 'running' ? 'animate-spin' : ''}`}>{statusIcon}</span>
        <span className="text-gray-300 text-xs font-medium">Sub-agent</span>
        {session.isBackground && (
          <span className="text-xs text-gray-600 border border-gray-800 rounded px-1">bg</span>
        )}
        <span className="text-gray-400 text-xs flex-1 truncate">{session.description}</span>
      </div>
      {(session.progress || session.iterations > 0) && (
        <div className="mt-1 flex gap-3 text-xs text-gray-600 pl-5">
          {session.iterations > 0 && <span>{session.iterations} iters</span>}
          {session.toolCallCount > 0 && <span>{session.toolCallCount} tools</span>}
          {session.progress && <span className="truncate flex-1">{session.progress}</span>}
        </div>
      )}
    </div>
  );
}

export function ToolRegion({ toolCalls, agentSessions }: ToolRegionProps) {
  if (toolCalls.size === 0 && agentSessions.size === 0) return null;

  const activeSubAgents = Array.from(agentSessions.values()).filter(
    (s) => s.status === 'running'
  );

  return (
    <div className="space-y-2 mt-2">
      {Array.from(toolCalls.entries()).map(([id, entry]) => (
        <ToolCard key={id} toolCallId={id} entry={entry} />
      ))}
      {activeSubAgents.map((s) => (
        <SubAgentCard key={s.toolCallId} session={s} />
      ))}
    </div>
  );
}
