import { useState } from 'react';

interface ThinkingPanelProps {
  content: string;
}

export function ThinkingPanel({ content }: ThinkingPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-gray-800/60 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-900/50 text-gray-400 text-xs hover:bg-gray-900 transition-colors"
      >
        <span className={`transition-transform text-gray-600 ${open ? 'rotate-90' : ''}`}>{'▶'}</span>
        <span className="text-purple-400/70">Thinking</span>
        <span className="text-gray-700 ml-1">({content.length} chars)</span>
        <span className="ml-auto text-gray-700">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-3 py-2 bg-gray-950/50 text-gray-500 text-xs whitespace-pre-wrap font-mono max-h-64 overflow-y-auto border-t border-gray-800/40">
          {content}
        </div>
      )}
    </div>
  );
}
