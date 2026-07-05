import { useRef, useEffect } from 'react';
import type { AgentState } from '@cortx/store';
import type { ActivityEntry, TurnEntry, ToolCallEntry, AgentSessionSummary } from '@cortx/store';
import type { WebApprovalMode, WebWorkspaceToolMode } from '../bridge/event-bridge';
import { visibleActivityEntries } from '../activity';
import { ActivityCard } from './ActivityTimeline';
import { PromptInput } from './PromptInput';
import { StreamingText } from './StreamingText';
import { ThinkingPanel } from './ThinkingPanel';
import { MessageBubble } from './MessageBubble';
import type { AgentStatus } from '@cortx/store';
import { surface } from '../design';

interface ChatViewProps {
  messages: AgentState['messages'];
  activity: ActivityEntry[];
  toolCalls: Map<string, ToolCallEntry>;
  agentSessions: Map<string, AgentSessionSummary>;
  status: AgentStatus;
  iteration: number;
  error: string | undefined;
  toolMode: WebWorkspaceToolMode;
  approvalMode: WebApprovalMode;
  selectedWorkingDirectory: string | null;
  willCreateSessionOnSend: boolean;
  onSend: (message: string) => void;
  onAbort: () => void;
  onResume: () => void;
  onCreateSessionForCurrentProject: () => void | Promise<unknown>;
  onToolModeChange: (mode: WebWorkspaceToolMode) => void;
  onApprovalModeChange: (mode: WebApprovalMode) => void;
}

type TimelineEntry =
  | { kind: 'message'; key: string; timestamp: number; index: number; turn: TurnEntry }
  | { kind: 'activity'; key: string; timestamp: number; index: number; activity: ActivityEntry };

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-rose-700">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
        Error
      </div>
      <div className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed text-rose-700">{message}</div>
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-4 py-16">
      <div className="mb-4 inline-flex w-fit rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-500">
        Ready for a workspace task
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">What should Cortx work on?</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600">
        Start with a concrete request. Assistant output, tool calls and sub-agent runs will stay in this conversation.
      </p>
    </div>
  );
}

function buildTimeline(messages: AgentState['messages'], activity: ActivityEntry[]): TimelineEntry[] {
  return [
    ...messages.turns.map((turn, index) => ({
      kind: 'message' as const,
      key: `message:${turn.timestamp}:${index}`,
      timestamp: turn.timestamp,
      index,
      turn,
    })),
    ...visibleActivityEntries(activity).map((entry, index) => ({
      kind: 'activity' as const,
      key: `activity:${entry.kind}:${entry.id}`,
      timestamp: entry.timestamp,
      index: messages.turns.length + index,
      activity: entry,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
}

export function ChatView({
  messages,
  activity,
  toolCalls,
  agentSessions,
  status,
  iteration,
  error,
  toolMode,
  approvalMode,
  selectedWorkingDirectory,
  willCreateSessionOnSend,
  onSend,
  onAbort,
  onResume,
  onCreateSessionForCurrentProject,
  onToolModeChange,
  onApprovalModeChange,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.currentText, messages.turns.length, activity, toolCalls.size, agentSessions.size, error]);

  const hasConversation =
    messages.turns.length > 0 ||
    activity.length > 0 ||
    Boolean(messages.currentText) ||
    Boolean(messages.currentThinking) ||
    Boolean(error);
  const timeline = buildTimeline(messages, activity);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[#fbfbfa]">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {hasConversation ? (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-8 sm:px-6 lg:px-8">
            {timeline.map((entry) =>
              entry.kind === 'message' ? (
                <MessageBubble
                  key={entry.key}
                  role={entry.turn.role}
                  content={entry.turn.content}
                  duration={entry.turn.duration}
                />
              ) : (
                <ActivityCard key={entry.key} entry={entry.activity} />
              ),
            )}
            {messages.currentThinking && <ThinkingPanel content={messages.currentThinking} />}
            {messages.currentText && <StreamingText text={messages.currentText} />}
            {error && <ErrorBanner message={error} />}
          </div>
        ) : (
          <EmptyConversation />
        )}
      </div>

      {status === 'running' && (
        <div className="flex items-center gap-3 border-t border-zinc-200 bg-white px-4 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs text-zinc-500">Cortx is working</span>
          {iteration > 0 && <span className="ml-auto font-mono text-xs text-zinc-600">turn {iteration}</span>}
          <button
            type="button"
            onClick={onAbort}
            className={`rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 ${surface.focus}`}
          >
            Stop
          </button>
        </div>
      )}
      {status === 'error' && (
        <div className="flex justify-end border-t border-zinc-200 bg-white px-4 py-2">
          <button
            type="button"
            onClick={onResume}
            className={`rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 ${surface.focus}`}
          >
            Resume
          </button>
        </div>
      )}
      <PromptInput
        onSend={onSend}
        disabled={status === 'awaiting_user'}
        mode={status === 'running' ? 'follow-up' : 'prompt'}
        toolMode={toolMode}
        approvalMode={approvalMode}
        selectedWorkingDirectory={selectedWorkingDirectory}
        canChangeModes={status !== 'running' && status !== 'awaiting_user'}
        willCreateSessionOnSend={willCreateSessionOnSend}
        onCreateSession={onCreateSessionForCurrentProject}
        onToolModeChange={onToolModeChange}
        onApprovalModeChange={onApprovalModeChange}
      />
    </section>
  );
}
