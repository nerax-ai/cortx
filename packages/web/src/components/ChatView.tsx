import { useRef, useEffect } from 'react';
import type { AgentState } from '@cortx/store';
import { PromptInput } from './PromptInput';
import { StreamingText } from './StreamingText';
import { ThinkingPanel } from './ThinkingPanel';
import { MessageBubble } from './MessageBubble';
import { ToolRegion } from './ToolRegion';
import type { AgentStatus } from '@cortx/store';

interface ChatViewProps {
  messages: AgentState['messages'];
  toolCalls: AgentState['toolCalls'];
  agentSessions: AgentState['agentSessions'];
  status: AgentStatus;
  onSend: (message: string) => void;
}

export function ChatView({ messages, toolCalls, agentSessions, status, onSend }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.currentText, messages.turns.length, toolCalls.size]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.turns.map((turn, i) => (
          <MessageBubble key={i} role={turn.role} content={turn.content} />
        ))}
        {messages.currentThinking && (
          <ThinkingPanel content={messages.currentThinking} />
        )}
        {messages.currentText && (
          <StreamingText text={messages.currentText} />
        )}
        {toolCalls.size > 0 && (
          <ToolRegion toolCalls={toolCalls} agentSessions={agentSessions} />
        )}
      </div>
      <PromptInput
        onSend={onSend}
        disabled={status === 'running'}
      />
    </div>
  );
}
