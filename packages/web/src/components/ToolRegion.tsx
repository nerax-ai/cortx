import type { ToolCallEntry, AgentSessionSummary } from '@cortx/store';
import { ToolCard } from './ToolCard';

interface ToolRegionProps {
  toolCalls: Map<string, ToolCallEntry>;
  agentSessions: Map<string, AgentSessionSummary>;
}

export function ToolRegion({ toolCalls, agentSessions }: ToolRegionProps) {
  if (toolCalls.size === 0) return null;

  return (
    <div className="space-y-2 mt-2">
      {Array.from(toolCalls.entries()).map(([id, entry]) => (
        <ToolCard key={id} toolCallId={id} entry={entry} />
      ))}
      {Array.from(agentSessions.values())
        .filter((s) => s.status === 'running')
        .map((s) => (
          <div key={s.toolCallId} className="bg-gray-900 border border-gray-800 rounded p-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-blue-400">⟳</span>
              <span className="text-gray-200">{s.description}</span>
              {s.progress && (
                <span className="text-gray-500 text-xs truncate">{s.progress}</span>
              )}
            </div>
          </div>
        ))}
    </div>
  );
}
