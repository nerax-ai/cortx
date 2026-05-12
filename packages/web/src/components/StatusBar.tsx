import type { AgentStatus, TokenUsage } from '@cortx/store';

interface StatusBarProps {
  status: AgentStatus;
  sessionId: string | null;
  tokenUsage: TokenUsage;
  elapsed: number;
}

export function StatusBar({ status, sessionId, tokenUsage, elapsed }: StatusBarProps) {
  const statusColors: Record<string, string> = {
    idle: 'bg-gray-600',
    running: 'bg-green-500',
    error: 'bg-red-500',
    awaiting_user: 'bg-yellow-500',
  };

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-gray-900 border-b border-gray-800 text-sm">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${statusColors[status] ?? 'bg-gray-600'}`} />
        <span className="text-gray-300 capitalize">{status.replace('_', ' ')}</span>
      </div>
      {sessionId && (
        <span className="text-gray-500 font-mono text-xs">{sessionId.slice(0, 16)}...</span>
      )}
      <div className="ml-auto flex gap-4 text-gray-500">
        <span>In: {tokenUsage.inputTokens}</span>
        <span>Out: {tokenUsage.outputTokens}</span>
        <span>{elapsed}s</span>
      </div>
    </div>
  );
}
