import { useState } from 'react';
import type { ToolCallEntry } from '@cortx/store';

interface ToolCardProps {
  toolCallId: string;
  entry: ToolCallEntry;
}

function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function truncate(str: string, max = 80): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}

export function ToolCard({ entry }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [showOutput, setShowOutput] = useState(false);

  const isPending = entry.status === 'pending';
  const isError = entry.isError === true;

  const statusIcon = isPending ? (
    <span className="text-yellow-500 animate-pulse">⏳</span>
  ) : isError ? (
    <span className="text-red-400">✗</span>
  ) : (
    <span className="text-green-400">✓</span>
  );

  const inputStr = formatValue(entry.input);
  const resultStr = entry.result != null ? formatValue(entry.result) : null;

  return (
    <div className={`bg-gray-900 border rounded-lg text-sm overflow-hidden ${
      isError ? 'border-red-900/40' : isPending ? 'border-yellow-900/30' : 'border-gray-800/60'
    }`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-800/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {statusIcon}
        <span className="text-gray-200 font-medium font-mono text-xs">{entry.toolName}</span>
        {entry.progress && (
          <span className="text-gray-600 text-xs truncate flex-1">{truncate(entry.progress, 60)}</span>
        )}
        {!entry.progress && inputStr && (
          <span className="text-gray-700 text-xs truncate flex-1 font-mono">{truncate(inputStr, 60)}</span>
        )}
        <span className={`text-xs transition-colors ${expanded ? 'text-blue-400' : 'text-gray-700'}`}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-gray-800/40">
          {inputStr && (
            <div className="px-3 py-1">
              <button
                onClick={(e) => { e.stopPropagation(); setShowInput(!showInput); }}
                className="text-xs text-gray-500 hover:text-gray-400 flex items-center gap-1"
              >
                <span className={`transition-transform text-[10px] ${showInput ? 'rotate-90' : ''}`}>▶</span>
                Input
              </button>
              {showInput && (
                <pre className="mt-1 p-2 bg-gray-950/60 rounded text-xs text-gray-400 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono border border-gray-800/30">
                  {inputStr}
                </pre>
              )}
            </div>
          )}
          {resultStr && (
            <div className="px-3 py-1">
              <button
                onClick={(e) => { e.stopPropagation(); setShowOutput(!showOutput); }}
                className={`text-xs flex items-center gap-1 ${isError ? 'text-red-500/70 hover:text-red-400' : 'text-gray-500 hover:text-gray-400'}`}
              >
                <span className={`transition-transform text-[10px] ${showOutput ? 'rotate-90' : ''}`}>▶</span>
                Output {isError && '(error)'}
              </button>
              {showOutput && (
                <pre className={`mt-1 p-2 bg-gray-950/60 rounded text-xs max-h-64 overflow-y-auto whitespace-pre-wrap font-mono border ${
                  isError ? 'text-red-400/80 border-red-900/30' : 'text-gray-400 border-gray-800/30'
                }`}>
                  {resultStr}
                </pre>
              )}
            </div>
          )}
          {isPending && !resultStr && (
            <div className="px-3 py-2 text-xs text-gray-600 italic">Waiting for result...</div>
          )}
        </div>
      )}
    </div>
  );
}
