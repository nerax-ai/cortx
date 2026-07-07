import { memo } from 'react';
import { MarkdownContent } from './MarkdownContent';

interface MessageBubbleProps {
  role: string;
  content: string;
  duration?: number;
}

export const MessageBubble = memo(function MessageBubble({ role, content, duration }: MessageBubbleProps) {
  const isUser = role === 'user';
  const label = isUser ? 'You' : 'Cortx';

  return (
    <article className={`group grid gap-2 ${isUser ? 'justify-items-end' : 'justify-items-start'}`}>
      <div className={`flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] ${isUser ? 'text-sky-600' : 'text-zinc-500'}`}>
        <span>{label}</span>
        {duration != null && duration > 0 && <span className="font-mono text-zinc-400">{duration.toFixed(1)}s</span>}
      </div>
      <div
        className={
          isUser
            ? 'max-w-[min(760px,92%)] rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-zinc-950'
            : 'max-w-[min(820px,100%)] border-l border-zinc-200 px-4 py-1 text-sm leading-7 text-zinc-800'
        }
      >
        <MarkdownContent text={content} />
      </div>
    </article>
  );
});
