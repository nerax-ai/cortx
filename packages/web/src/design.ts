import type { AgentSessionSummary, AgentStatus, TokenUsage, ToolCallEntry } from '@cortx/store';

export interface StatusTone {
  label: string;
  dotClass: string;
  textClass: string;
  badgeClass: string;
  busy: boolean;
}

const STATUS_TONES: Record<AgentStatus, StatusTone> = {
  idle: {
    label: 'Ready',
    dotClass: 'bg-zinc-400',
    textClass: 'text-zinc-300',
    badgeClass: 'border-zinc-700 bg-zinc-900/80 text-zinc-300',
    busy: false,
  },
  running: {
    label: 'Working',
    dotClass: 'bg-emerald-400',
    textClass: 'text-emerald-300',
    badgeClass: 'border-emerald-500/30 bg-emerald-950/40 text-emerald-200',
    busy: true,
  },
  awaiting_user: {
    label: 'Awaiting Input',
    dotClass: 'bg-amber-300',
    textClass: 'text-amber-200',
    badgeClass: 'border-amber-400/30 bg-amber-950/40 text-amber-100',
    busy: true,
  },
  error: {
    label: 'Error',
    dotClass: 'bg-rose-400',
    textClass: 'text-rose-200',
    badgeClass: 'border-rose-400/30 bg-rose-950/40 text-rose-100',
    busy: false,
  },
};

export const surface = {
  page: 'min-h-screen bg-[#111111] text-zinc-100 antialiased',
  panel: 'border border-white/8 bg-[#181818] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]',
  softPanel: 'border border-white/6 bg-[#151515]',
  muted: 'text-zinc-500',
  subtle: 'text-zinc-400',
  focus: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/45',
};

export function statusTone(status: AgentStatus): StatusTone {
  return STATUS_TONES[status];
}

export function compactPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  if (parts.length === 1) return parts[0];
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

export function compactSessionId(id: string | undefined, size = 10): string {
  if (!id) return 'no session';
  if (id.length <= size) return id;
  return `${id.slice(0, Math.max(4, size))}`;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return value.toLocaleString();
}

export function formatTokenUsage(usage: TokenUsage): string {
  return `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out`;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 1) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export interface InspectorSummary {
  totalTools: number;
  pendingTools: number;
  failedTools: number;
  completedTools: number;
  totalAgents: number;
  runningAgents: number;
  failedAgents: number;
  backgroundAgents: number;
}

export function summarizeInspector(
  toolCalls: Map<string, ToolCallEntry>,
  agentSessions: Map<string, AgentSessionSummary>,
): InspectorSummary {
  const tools = Array.from(toolCalls.values());
  const agents = Array.from(agentSessions.values());

  return {
    totalTools: tools.length,
    pendingTools: tools.filter((tool) => tool.status === 'pending').length,
    failedTools: tools.filter((tool) => tool.isError).length,
    completedTools: tools.filter((tool) => tool.status === 'complete' && !tool.isError).length,
    totalAgents: agents.length,
    runningAgents: agents.filter((agent) => agent.status === 'running').length,
    failedAgents: agents.filter((agent) => agent.status === 'error').length,
    backgroundAgents: agents.filter((agent) => agent.isBackground).length,
  };
}

export function truncateMiddle(value: string, max = 42): string {
  if (value.length <= max) return value;
  const edge = Math.max(4, Math.floor((max - 3) / 2));
  return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}
