interface MessageBubbleProps {
  role: string;
  content: string;
  duration?: number;
}

export function MessageBubble({ role, content, duration }: MessageBubbleProps) {
  const isUser = role === 'user';
  const label = isUser ? 'You' : 'Cortx';

  return (
    <article className={`group grid gap-2 ${isUser ? 'justify-items-end' : 'justify-items-start'}`}>
      <div className={`flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] ${isUser ? 'text-cyan-300/70' : 'text-zinc-500'}`}>
        <span>{label}</span>
        {duration != null && duration > 0 && <span className="font-mono text-zinc-700">{duration.toFixed(1)}s</span>}
      </div>
      <div
        className={
          isUser
            ? 'max-w-[min(760px,92%)] rounded-xl border border-cyan-300/15 bg-cyan-950/20 px-4 py-3 text-sm leading-6 text-cyan-50'
            : 'max-w-[min(820px,100%)] border-l border-white/10 px-4 py-1 text-sm leading-7 text-zinc-200'
        }
      >
        <div className="whitespace-pre-wrap break-words">{content}</div>
      </div>
    </article>
  );
}
