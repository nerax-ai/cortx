interface MessageBubbleProps {
  role: string;
  content: string;
  duration?: number;
}

export function MessageBubble({ role, content, duration }: MessageBubbleProps) {
  const isUser = role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-2.5 text-sm ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-gray-900 text-gray-100 border border-gray-800'
        }`}
      >
        {!isUser && (
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">Assistant</span>
            {duration != null && duration > 0 && (
              <span className="text-xs text-gray-600 font-mono">{duration.toFixed(1)}s</span>
            )}
          </div>
        )}
        <div className="whitespace-pre-wrap leading-relaxed">{content}</div>
      </div>
    </div>
  );
}
