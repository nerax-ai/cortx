import { useRef, useEffect } from 'react';
import type { AgentState } from '@cortx/store';
import type { TurnEntry, ToolCallEntry, AgentSessionSummary } from '@cortx/store';
import { PromptInput } from './PromptInput';
import { StreamingText } from './StreamingText';
import { ThinkingPanel } from './ThinkingPanel';
import { MessageBubble } from './MessageBubble';
import type { AgentStatus } from '@cortx/store';
import { summarizeInspector, surface } from '../design';

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
    <div className="rounded-lg border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-rose-200">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
        Error
      </div>
      <div className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed text-rose-100/80">{message}</div>
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-4 py-16">
      <div className="mb-4 inline-flex w-fit rounded-full border border-white/8 bg-white/5 px-3 py-1 text-xs text-zinc-400">
        Ready for a workspace task
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">What should Cortx work on?</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500">
        Start with a concrete request. The runtime will stream assistant output here while tools, approvals and sub-agents stay visible in the inspector.
      </p>
    </div>
  );
}

function MobileActivityStrip({
  toolCalls,
  agentSessions,
}: {
  toolCalls: Map<string, ToolCallEntry>;
  agentSessions: Map<string, AgentSessionSummary>;
}) {
  const summary = summarizeInspector(toolCalls, agentSessions);
  if (summary.totalTools === 0 && summary.totalAgents === 0) return null;

  return (
    <div className={`mx-auto max-w-3xl rounded-lg px-3 py-2 text-xs xl:hidden ${surface.panel}`}>
      <div className="flex flex-wrap items-center gap-3 text-zinc-500">
        <span className="text-zinc-300">Activity</span>
        <span>{summary.pendingTools} pending tools</span>
        <span>{summary.completedTools} complete</span>
        <span>{summary.runningAgents} running agents</span>
      </div>
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

  const hasConversation =
    messages.turns.length > 0 || Boolean(messages.currentText) || Boolean(messages.currentThinking) || Boolean(error);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[#111111]">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {hasConversation ? (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-8 sm:px-6 lg:px-8">
            {messages.turns.map((turn: TurnEntry, i: number) => (
              <MessageBubble key={`${turn.timestamp}-${i}`} role={turn.role} content={turn.content} duration={turn.duration} />
            ))}
            {messages.currentThinking && <ThinkingPanel content={messages.currentThinking} />}
            {messages.currentText && <StreamingText text={messages.currentText} />}
            <MobileActivityStrip toolCalls={toolCalls} agentSessions={agentSessions} />
            {error && <ErrorBanner message={error} />}
          </div>
        ) : (
          <EmptyConversation />
        )}
      </div>

      {status === 'running' && (
        <div className="flex items-center gap-3 border-t border-white/8 bg-[#151515] px-4 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs text-zinc-500">Cortx is working</span>
          {iteration > 0 && <span className="ml-auto font-mono text-xs text-zinc-600">turn {iteration}</span>}
          <button
            type="button"
            onClick={onAbort}
            className={`rounded-md border border-white/10 px-2.5 py-1 text-xs text-zinc-400 hover:border-rose-300/30 hover:text-rose-100 ${surface.focus}`}
          >
            Stop
          </button>
        </div>
      )}
      {status === 'error' && (
        <div className="flex justify-end border-t border-white/8 bg-[#151515] px-4 py-2">
          <button
            type="button"
            onClick={onResume}
            className={`rounded-md border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:border-cyan-300/30 hover:text-cyan-100 ${surface.focus}`}
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
    </section>
  );
}
