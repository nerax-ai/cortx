import { useRef, useEffect } from 'react';
import type { AgentState } from '@cortx/store';
import type { TurnEntry, ToolCallEntry, AgentSessionSummary } from '@cortx/store';
import { PromptInput } from './PromptInput';
import { StreamingText } from './StreamingText';
import { ThinkingPanel } from './ThinkingPanel';
import { MessageBubble } from './MessageBubble';
import { ToolRegion } from './ToolRegion';
import type { AgentStatus } from '@cortx/store';

interface ChatViewProps {
  messages: AgentState['messages'];
  toolCalls: Map<string, ToolCallEntry>;
  agentSessions: Map<string, AgentSessionSummary>;
  status: AgentStatus;
  iteration: number;
  error: string | undefined;
  onSend: (message: string) => void;
  onAbort: () => void;
  onResume: () => void;
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="bg-red-950/30 border border-red-900/40 rounded-lg px-4 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-red-400">✗</span>
        <span className="text-red-300 font-medium text-xs uppercase tracking-wider">Error</span>
      </div>
      <div className="text-red-400/80 mt-1 text-xs font-mono whitespace-pre-wrap">{message}</div>
    </div>
  );
}

export function ChatView({
  messages,
  toolCalls,
  agentSessions,
  status,
  iteration,
  error,
  onSend,
  onAbort,
  onResume,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.currentText, messages.turns.length, toolCalls.size, error]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.turns.map((turn: TurnEntry, i: number) => (
          <MessageBubble key={i} role={turn.role} content={turn.content} duration={turn.duration} />
        ))}
        {messages.currentThinking && <ThinkingPanel content={messages.currentThinking} />}
        {messages.currentText && <StreamingText text={messages.currentText} />}
        {toolCalls.size > 0 && <ToolRegion toolCalls={toolCalls} agentSessions={agentSessions} />}
        {error && <ErrorBanner message={error} />}
      </div>
      {status === 'running' && (
        <div className="px-4 py-1.5 bg-gray-900/50 border-t border-gray-800/40 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs text-gray-500">Agent is working...</span>
          {iteration > 0 && <span className="text-xs text-gray-700 font-mono ml-auto">iter {iteration}</span>}
          <button
            type="button"
            onClick={onAbort}
            className="text-xs px-2 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-gray-100 hover:border-gray-500"
          >
            Stop
          </button>
        </div>
      )}
      {status === 'error' && (
        <div className="px-4 py-1.5 bg-gray-900/50 border-t border-gray-800/40 flex justify-end">
          <button
            type="button"
            onClick={onResume}
            className="text-xs px-2 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-gray-100 hover:border-gray-500"
          >
            Resume
          </button>
        </div>
      )}
      <PromptInput
        onSend={onSend}
        disabled={status === 'awaiting_user'}
        mode={status === 'running' ? 'follow-up' : 'prompt'}
      />
    </div>
  );
}
