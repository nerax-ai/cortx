interface MessageBubbleProps {
  role: string;
  content: string;
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === 'user';
  const isTool = role === 'tool';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-blue-600 text-white'
            : isTool
              ? 'bg-gray-800 text-gray-300 font-mono text-xs'
              : 'bg-gray-900 text-gray-100'
        }`}
      >
        {!isUser && !isTool && (
          <div className="text-xs text-gray-500 mb-1 font-medium">assistant</div>
        )}
        <div className="whitespace-pre-wrap">{content}</div>
      </div>
    </div>
  );
}
