interface StreamingTextProps {
  text: string;
}

export function StreamingText({ text }: StreamingTextProps) {
  return (
    <div className="bg-gray-900 border border-blue-900/30 rounded-lg px-4 py-2.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-blue-400/60 font-semibold uppercase tracking-wider">Assistant</span>
        <span className="text-xs text-blue-400/40">streaming...</span>
      </div>
      <div className="whitespace-pre-wrap text-gray-100 text-sm leading-relaxed">
        {text}
        <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
      </div>
    </div>
  );
}
