import { useState } from 'react';

interface ThinkingPanelProps {
  content: string;
}

export function ThinkingPanel({ content }: ThinkingPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-900 text-gray-400 text-sm hover:bg-gray-850"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>{'>'}</span>
        Thinking...
      </button>
      {open && (
        <div className="px-3 py-2 bg-gray-950 text-gray-500 text-xs whitespace-pre-wrap font-mono max-h-60 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
}
