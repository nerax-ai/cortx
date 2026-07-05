import { useState } from 'react';

interface ThinkingPanelProps {
  content: string;
}

export function ThinkingPanel({ content }: ThinkingPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-500 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20"
      >
        <span className={`text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`}>{'>'}</span>
        <span className="text-zinc-700">Thinking</span>
        <span className="ml-1 text-zinc-400">{content.length} chars</span>
        <span className="ml-auto text-zinc-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs leading-5 text-zinc-500 whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
}
