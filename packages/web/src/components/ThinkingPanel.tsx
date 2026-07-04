import { useState } from 'react';

interface ThinkingPanelProps {
  content: string;
}

export function ThinkingPanel({ content }: ThinkingPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-white/8 bg-white/[0.025]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-500 transition-colors hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/35"
      >
        <span className={`text-zinc-700 transition-transform ${open ? 'rotate-90' : ''}`}>{'>'}</span>
        <span className="text-zinc-400">Thinking</span>
        <span className="ml-1 text-zinc-700">{content.length} chars</span>
        <span className="ml-auto text-zinc-700">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-white/8 bg-black/20 px-3 py-2 font-mono text-xs leading-5 text-zinc-500 whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
}
