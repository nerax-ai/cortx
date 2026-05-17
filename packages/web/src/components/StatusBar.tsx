import type { AgentStatus, TokenUsage } from '@cortx/store';

interface StatusBarProps {
  status: AgentStatus;
  sessionId: string | null;
  tokenUsage: TokenUsage;
  elapsed: number;
  iteration: number;
}

export function StatusBar({ status, sessionId, tokenUsage, elapsed, iteration }: StatusBarProps) {
  const statusConfig: Record<AgentStatus, { color: string; label: string; pulse: boolean }> = {
    idle: { color: 'bg-gray-500', label: 'Ready', pulse: false },
    running: { color: 'bg-green-500', label: 'Running', pulse: true },
    error: { color: 'bg-red-500', label: 'Error', pulse: false },
    awaiting_user: { color: 'bg-yellow-500', label: 'Awaiting Input', pulse: true },
  };

  const cfg = statusConfig[status];

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800 text-sm select-none">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${cfg.color} ${cfg.pulse ? 'animate-pulse' : ''}`} />
        <span className="text-gray-300 font-medium">{cfg.label}</span>
      </div>
      {iteration > 0 && (
        <span className="text-gray-500 text-xs">
          Iteration {iteration}
        </span>
      )}
      {sessionId && (
        <span className="text-gray-600 font-mono text-xs truncate max-w-32">{sessionId.slice(0, 20)}</span>
      )}
      <div className="ml-auto flex gap-3 text-gray-500 text-xs font-mono">
        <span title="Input tokens">
          <span className="text-gray-600">In</span> {tokenUsage.inputTokens.toLocaleString()}
        </span>
        <span title="Output tokens">
          <span className="text-gray-600">Out</span> {tokenUsage.outputTokens.toLocaleString()}
        </span>
        <span title="Elapsed time">
          <span className="text-gray-600">Time</span> {elapsed.toFixed(1)}s
        </span>
      </div>
    </div>
  );
}
