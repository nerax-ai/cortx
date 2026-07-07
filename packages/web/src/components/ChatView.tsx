import { useRef, useEffect, useMemo, useState, useLayoutEffect, useCallback } from 'react';
import type { AgentState } from '@cortx/store';
import type { ActivityEntry, TurnEntry, TokenUsage, ToolCallEntry, AgentSessionSummary } from '@cortx/store';
import type { WebApprovalMode, WebModelInfo, WebSkillInfo, WebWorkspaceToolMode } from '../bridge/event-bridge';
import { visibleActivityEntries } from '../activity';
import type { ContextUsageSummary } from '../context-usage';
import { ActivityCard } from './ActivityTimeline';
import { PromptInput, buildPromptHistory, type QueuedPrompt } from './PromptInput';
import { StreamingText } from './StreamingText';
import { ThinkingPanel } from './ThinkingPanel';
import { MessageBubble } from './MessageBubble';
import type { AgentStatus } from '@cortx/store';
import { surface } from '../design';

interface ChatViewProps {
  sessionId?: string;
  messages: AgentState['messages'];
  activity: ActivityEntry[];
  toolCalls: Map<string, ToolCallEntry>;
  agentSessions: Map<string, AgentSessionSummary>;
  contextUsage?: ContextUsageSummary;
  tokenUsage: TokenUsage;
  status: AgentStatus;
  error: string | undefined;
  skills: WebSkillInfo[];
  models: WebModelInfo[];
  model?: string;
  reasoningEffort?: string;
  promptHistory?: string[];
  queuedPrompts?: QueuedPrompt[];
  hasOlderHistory?: boolean;
  isLoadingOlderHistory?: boolean;
  toolMode: WebWorkspaceToolMode;
  approvalMode: WebApprovalMode;
  onSend: (message: string) => void;
  onAbort: () => void;
  onResume: () => void;
  onSteerQueuedPrompt: (id: string) => void;
  onDeleteQueuedPrompt: (id: string) => void;
  onLoadOlderHistory: () => void | Promise<void>;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  onToolModeChange: (mode: WebWorkspaceToolMode) => void;
  onApprovalModeChange: (mode: WebApprovalMode) => void;
}

type TimelineEntry =
  | { kind: 'message'; key: string; timestamp: number; index: number; turn: TurnEntry }
  | { kind: 'activity'; key: string; timestamp: number; index: number; activity: ActivityEntry };

const INITIAL_TIMELINE_WINDOW = 120;
const TIMELINE_PAGE_SIZE = 80;
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
  sessionId,
  messages,
  activity,
  toolCalls,
  agentSessions,
  contextUsage,
  tokenUsage,
  status,
  error,
  skills,
  models,
  model,
  reasoningEffort,
  promptHistory: sessionPromptHistory = [],
  queuedPrompts = [],
  hasOlderHistory = false,
  isLoadingOlderHistory = false,
  toolMode,
  approvalMode,
  onSend,
  onAbort,
  onResume,
  onSteerQueuedPrompt,
  onDeleteQueuedPrompt,
  onLoadOlderHistory,
  onModelChange,
  onReasoningEffortChange,
  onToolModeChange,
  onApprovalModeChange,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const suppressNextAutoScrollRef = useRef(false);
  const [visibleTimelineCount, setVisibleTimelineCount] = useState(INITIAL_TIMELINE_WINDOW);

  useEffect(() => {
    setVisibleTimelineCount(INITIAL_TIMELINE_WINDOW);
  }, [sessionId]);

  useEffect(() => {
    if (scrollRestoreRef.current || suppressNextAutoScrollRef.current) {
      suppressNextAutoScrollRef.current = false;
      return;
    }
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [sessionId, messages.currentText, messages.turns.length, activity, toolCalls.size, agentSessions.size, error]);

  const hasConversation =
    messages.turns.length > 0 ||
    activity.length > 0 ||
    Boolean(messages.currentText) ||
    Boolean(messages.currentThinking) ||
    Boolean(error);
  const timeline = useMemo(() => buildTimeline(messages, activity), [messages, activity]);
  const displayedTimelineCount = Math.min(visibleTimelineCount, timeline.length);
  const hiddenTimelineCount = Math.max(0, timeline.length - displayedTimelineCount);
  const displayedTimeline = hiddenTimelineCount === 0 ? timeline : timeline.slice(-displayedTimelineCount);
  const nextOlderCount = Math.min(TIMELINE_PAGE_SIZE, hiddenTimelineCount);
  const hasTopHistoryControl = hiddenTimelineCount > 0 || hasOlderHistory;
  const loadOlderTimeline = useCallback(() => {
    if (hiddenTimelineCount === 0 || scrollRestoreRef.current) return;
    suppressNextAutoScrollRef.current = true;
    const scroll = scrollRef.current;
    if (scroll) {
      scrollRestoreRef.current = {
        scrollHeight: scroll.scrollHeight,
        scrollTop: scroll.scrollTop,
      };
    }
    setVisibleTimelineCount((count) => Math.min(timeline.length, count + TIMELINE_PAGE_SIZE));
  }, [hiddenTimelineCount, timeline.length]);
  const loadOlderHistory = useCallback(async () => {
    if (!hasOlderHistory || isLoadingOlderHistory || scrollRestoreRef.current) return;
    suppressNextAutoScrollRef.current = true;
    const scroll = scrollRef.current;
    if (scroll) {
      scrollRestoreRef.current = {
        scrollHeight: scroll.scrollHeight,
        scrollTop: scroll.scrollTop,
      };
    }
    await onLoadOlderHistory();
  }, [hasOlderHistory, isLoadingOlderHistory, onLoadOlderHistory]);
  const handleTimelineScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll || !hasTopHistoryControl) return;
    if (scroll.scrollTop > 72) return;
    if (hiddenTimelineCount > 0) loadOlderTimeline();
    else void loadOlderHistory();
  }, [hasTopHistoryControl, hiddenTimelineCount, loadOlderHistory, loadOlderTimeline]);

  useIsomorphicLayoutEffect(() => {
    const restore = scrollRestoreRef.current;
    const scroll = scrollRef.current;
    if (!restore || !scroll) return;
    scroll.scrollTop = restore.scrollTop + (scroll.scrollHeight - restore.scrollHeight);
    scrollRestoreRef.current = null;
  });

  const promptHistoryMessages = useMemo(
    () =>
      buildPromptHistory(
        sessionPromptHistory,
        messages.turns.filter((turn) => turn.role === 'user').map((turn) => turn.content),
      ),
    [messages.turns, sessionPromptHistory],
  );
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[#fbfbfa]">
      <div ref={scrollRef} onScroll={handleTimelineScroll} className="min-h-0 flex-1 overflow-y-auto">
        {hasConversation ? (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-8 sm:px-6 lg:px-8">
            {hasTopHistoryControl && (
              <div className="flex flex-col items-center gap-1 text-center">
                <button
                  type="button"
                  onClick={() => {
                    if (hiddenTimelineCount > 0) loadOlderTimeline();
                    else void loadOlderHistory();
                  }}
                  disabled={hiddenTimelineCount === 0 && isLoadingOlderHistory}
                  className={`rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 shadow-sm hover:border-zinc-300 hover:text-zinc-900 ${surface.focus}`}
                >
                  {hiddenTimelineCount > 0
                    ? `Load older ${nextOlderCount} item${nextOlderCount === 1 ? '' : 's'}`
                    : isLoadingOlderHistory
                    ? 'Loading earlier events'
                    : 'Load earlier session history'}
                </button>
                <div className="text-[11px] text-zinc-400">
                  {hiddenTimelineCount > 0
                    ? `Scroll up to continue loading ${hiddenTimelineCount} older item${hiddenTimelineCount === 1 ? '' : 's'}`
                    : 'Scroll up to fetch earlier persisted events'}
                </div>
              </div>
            )}
            {displayedTimeline.map((entry) =>
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
        skills={skills}
        models={models}
        model={model}
        reasoningEffort={reasoningEffort}
        historyMessages={promptHistoryMessages}
        queuedPrompts={queuedPrompts}
        disabled={status === 'awaiting_user'}
        status={status}
        toolMode={toolMode}
        approvalMode={approvalMode}
        contextUsage={contextUsage}
        tokenUsage={tokenUsage}
        canChangeModes={status !== 'awaiting_user'}
        onAbort={onAbort}
        onResume={onResume}
        onSteerQueuedPrompt={onSteerQueuedPrompt}
        onDeleteQueuedPrompt={onDeleteQueuedPrompt}
        onModelChange={onModelChange}
        onReasoningEffortChange={onReasoningEffortChange}
        onToolModeChange={onToolModeChange}
        onApprovalModeChange={onApprovalModeChange}
      />
    </section>
  );
}
