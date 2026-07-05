interface StreamingTextProps {
  text: string;
}

export function StreamingText({ text }: StreamingTextProps) {
  return (
    <article className="grid gap-2 justify-items-start">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-emerald-700">
        <span>Cortx</span>
        <span className="text-zinc-400">streaming</span>
      </div>
      <div className="max-w-[min(820px,100%)] border-l border-emerald-200 px-4 py-1 text-sm leading-7 text-zinc-900">
        <div className="whitespace-pre-wrap break-words">
        {text}
          <span className="ml-1 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-emerald-300 align-text-bottom" />
        </div>
      </div>
    </article>
  );
}
