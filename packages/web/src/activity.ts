import type { ActivityEntry, AgentSessionSummary, ToolCallEntry } from '@cortx/store';

export function visibleActivityEntries(activity: ActivityEntry[]): ActivityEntry[] {
  const agentActivityIds = new Set(activity.filter((entry) => entry.kind === 'agent').map((entry) => entry.id));
  return activity.filter((entry) => {
    if (entry.kind !== 'tool') return true;
    return !(entry.entry.toolName === 'agent' && agentActivityIds.has(entry.id));
  });
}

export function activityToInspectorMaps(activity: ActivityEntry[]): {
  toolCalls: Map<string, ToolCallEntry>;
  agentSessions: Map<string, AgentSessionSummary>;
} {
  const toolCalls = new Map<string, ToolCallEntry>();
  const agentSessions = new Map<string, AgentSessionSummary>();

  for (const entry of visibleActivityEntries(activity)) {
    if (entry.kind === 'tool') {
      toolCalls.set(entry.id, entry.entry);
    } else {
      agentSessions.set(entry.id, entry.session);
    }
  }

  return { toolCalls, agentSessions };
}

export function latestIterationActivity(activity: ActivityEntry[]): ActivityEntry[] {
  const iterations = activity
    .map((entry) => entry.iteration)
    .filter((iteration): iteration is number => typeof iteration === 'number' && iteration > 0);
  if (iterations.length === 0) return activity;
  const latestIteration = Math.max(...iterations);
  return activity.filter((entry) => entry.iteration === latestIteration);
}
