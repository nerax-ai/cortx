import { useState } from 'react';
import type { ToolCallEntry } from '@cortx/store';

interface ToolCardProps {
  toolCallId: string;
  entry: ToolCallEntry;
}

export function ToolCard({ entry }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = entry.status === 'pending' ? '⏳'
    : entry.isError ? '✗'
    : '✓';

  const statusColor = entry.status === 'pending' ? 'text-yellow-500'
    : entry.isError ? 'text-red-500'
    : 'text-green-500';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-2 text-sm">
      <div className="flex items-center gap-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span className={statusColor}>{statusIcon}</span>
        <span className="text-gray-200 font-medium">{entry.toolName}</span>
        {entry.progress && (
          <span className="text-gray-500 text-xs truncate flex-1">{entry.progress}</span>
        )}
        <span className={`text-xs ${expanded ? 'text-blue-400' : 'text-gray-600'}`}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>
      {expanded && entry.result != null && (
        <pre className="mt-2 p-2 bg-gray-950 rounded text-xs text-gray-400 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
          {String(entry.result)}
        </pre>
      )}
    </div>
  );
}
