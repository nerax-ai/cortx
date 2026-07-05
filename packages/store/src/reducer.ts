import type { AgentDoneUsage, AgentEvent } from '@cortx/sdk';
import type {
  ActivityEntry,
  AgentSessionSummary,
  AgentState,
  TokenUsage,
  ToolCallEntry,
  TurnEntry,
} from './types.js';

export interface AgentReducerTiming {
  turnStartTime: number;
  totalStartTime: number;
  now?: () => number;
}

export interface AgentReducerResult {
  state: AgentState;
  turnStartTime: number;
  totalStartTime: number;
}

function upsertToolActivity(
  activity: ActivityEntry[],
  id: string,
  entry: ToolCallEntry,
  timestamp: number,
  iteration: number,
): ActivityEntry[] {
  const index = activity.findIndex((item) => item.kind === 'tool' && item.id === id);
  if (index === -1) return [...activity, { kind: 'tool', id, timestamp, iteration, entry }];
  const next = [...activity];
  next[index] = { kind: 'tool', id, timestamp: next[index].timestamp, iteration: next[index].iteration ?? iteration, entry };
  return next;
}

function upsertAgentActivity(
  activity: ActivityEntry[],
  id: string,
  session: AgentSessionSummary,
  timestamp: number,
  iteration: number,
): ActivityEntry[] {
  const index = activity.findIndex((item) => item.kind === 'agent' && item.id === id);
  if (index === -1) return [...activity, { kind: 'agent', id, timestamp, iteration, session }];
  const next = [...activity];
  next[index] = { kind: 'agent', id, timestamp: next[index].timestamp, iteration: next[index].iteration ?? iteration, session };
  return next;
}

function elapsedSeconds(start: number, end: number): number {
  if (start <= 0) return 0;
  return Math.max(0, (end - start) / 1000);
}

function addOptionalTokenField(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return (current ?? 0) + next;
}

function addTokenUsage(current: TokenUsage, next: AgentDoneUsage): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
  };
  const noCacheInputTokens = addOptionalTokenField(current.noCacheInputTokens, next.noCacheInputTokens);
  const cacheReadTokens = addOptionalTokenField(current.cacheReadTokens, next.cacheReadTokens);
  const cacheCreationTokens = addOptionalTokenField(current.cacheCreationTokens, next.cacheCreationTokens);
  const reasoningTokens = addOptionalTokenField(current.reasoningTokens, next.reasoningTokens);
  if (noCacheInputTokens !== undefined) usage.noCacheInputTokens = noCacheInputTokens;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) usage.cacheCreationTokens = cacheCreationTokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  return usage;
}

export function reduceAgentEvent(
  state: AgentState,
  event: AgentEvent,
  timing: AgentReducerTiming,
): AgentReducerResult {
  const now = timing.now?.() ?? Date.now();
  let turnStartTime = timing.turnStartTime;
  let totalStartTime = timing.totalStartTime;
  let nextState = state;

  switch (event.type) {
    case 'turn_start': {
      const prev = state.messages;
      let turns = [...prev.turns];
      const turnDuration = elapsedSeconds(turnStartTime, now);
      if (prev.currentText.length > 0) {
        turns = [...turns, { role: 'assistant', content: prev.currentText, timestamp: now, duration: turnDuration } satisfies TurnEntry];
      } else if (turnDuration > 0 && turns.length > 0) {
        const last = turns[turns.length - 1];
        if (!last.duration) turns[turns.length - 1] = { ...last, duration: turnDuration };
      }
      nextState = {
        ...state,
        iteration: event.iteration,
        status: 'running',
        messages: { turns, currentText: '', currentThinking: '' },
        toolCalls: new Map(),
        totalElapsed: state.totalElapsed + turnDuration,
        elapsed: 0,
        error: undefined,
      };
      turnStartTime = now;
      if (totalStartTime === 0) totalStartTime = now;
      break;
    }

    case 'text_delta': {
      nextState = {
        ...state,
        messages: {
          ...state.messages,
          currentText: state.messages.currentText + event.delta,
        },
      };
      break;
    }

    case 'thinking_delta': {
      nextState = {
        ...state,
        messages: {
          ...state.messages,
          currentThinking: state.messages.currentThinking + event.delta,
        },
      };
      break;
    }

    case 'text': {
      nextState = {
        ...state,
        messages: {
          ...state.messages,
          currentText: event.content,
        },
      };
      break;
    }

    case 'thinking': {
      nextState = {
        ...state,
        messages: {
          ...state.messages,
          currentThinking: event.content,
        },
      };
      break;
    }

    case 'tool_use': {
      const prev = state.messages;
      const turns =
        prev.currentText.length > 0
          ? [...prev.turns, { role: 'assistant', content: prev.currentText, timestamp: now } satisfies TurnEntry]
          : prev.turns;
      const toolCalls = new Map(state.toolCalls);
      const entry = {
        toolName: event.toolCall.toolName,
        input: event.toolCall.input,
        status: 'pending',
      } satisfies ToolCallEntry;
      toolCalls.set(event.toolCall.toolCallId, entry);
      nextState = {
        ...state,
        messages: { turns, currentText: '', currentThinking: '' },
        toolCalls,
        activity: upsertToolActivity(state.activity, event.toolCall.toolCallId, entry, now, state.iteration),
      };
      break;
    }

    case 'tool_progress': {
      const toolCalls = new Map(state.toolCalls);
      const entry = toolCalls.get(event.toolCallId);
      if (entry) {
        toolCalls.set(event.toolCallId, {
          ...entry,
          progress: event.text,
        });
        nextState = {
          ...state,
          toolCalls,
          activity: upsertToolActivity(
            state.activity,
            event.toolCallId,
            { ...entry, progress: event.text },
            now,
            state.iteration,
          ),
        };
      }
      break;
    }

    case 'tool_result': {
      const toolCalls = new Map(state.toolCalls);
      const entry = toolCalls.get(event.toolCallId);
      if (entry) {
        const nextEntry = {
          ...entry,
          result: event.result,
          isError: event.isError,
          status: 'complete',
        } satisfies ToolCallEntry;
        toolCalls.set(event.toolCallId, nextEntry);
        nextState = {
          ...state,
          toolCalls,
          activity: upsertToolActivity(state.activity, event.toolCallId, nextEntry, now, state.iteration),
        };
      } else {
        nextState = { ...state, toolCalls };
      }
      break;
    }

    case 'done': {
      const turnElapsed = elapsedSeconds(turnStartTime, now);
      const usage: TokenUsage = event.usage ? addTokenUsage(state.tokenUsage, event.usage) : state.tokenUsage;
      const prev = state.messages;
      const turns =
        prev.currentText.length > 0
          ? [...prev.turns, { role: 'assistant', content: prev.currentText, timestamp: now, duration: turnElapsed } satisfies TurnEntry]
          : [...prev.turns];
      nextState = {
        ...state,
        status: 'idle',
        messages: { turns, currentText: '', currentThinking: '' },
        tokenUsage: usage,
        contextUsage: event.usage?.context ?? state.contextUsage,
        totalElapsed: state.totalElapsed + turnElapsed,
        elapsed: 0,
      };
      turnStartTime = 0;
      break;
    }

    case 'error': {
      const turnElapsed = elapsedSeconds(turnStartTime, now);
      const prev = state.messages;
      const turns =
        prev.currentText.length > 0
          ? [...prev.turns, { role: 'assistant', content: prev.currentText, timestamp: now, duration: turnElapsed } satisfies TurnEntry]
          : [...prev.turns];
      nextState = {
        ...state,
        status: 'error',
        messages: { turns, currentText: '', currentThinking: '' },
        error: event.error.message,
        totalElapsed: state.totalElapsed + turnElapsed,
        elapsed: 0,
      };
      turnStartTime = 0;
      break;
    }

    case 'agent_started': {
      const agentSessions = new Map(state.agentSessions);
      const session = {
        toolCallId: event.toolCallId,
        description: event.description,
        status: 'running',
        isBackground: event.isBackground ?? false,
        iterations: 0,
        toolCallCount: 0,
      } satisfies AgentSessionSummary;
      agentSessions.set(event.toolCallId, session);
      nextState = {
        ...state,
        agentSessions,
        activity: upsertAgentActivity(state.activity, event.toolCallId, session, now, state.iteration),
      };
      break;
    }

    case 'agent_progress': {
      const agentSessions = new Map(state.agentSessions);
      const entry = agentSessions.get(event.toolCallId);
      if (entry) {
        const nextSession = {
          ...entry,
          progress: event.text,
        } satisfies AgentSessionSummary;
        agentSessions.set(event.toolCallId, nextSession);
        nextState = {
          ...state,
          agentSessions,
          activity: upsertAgentActivity(state.activity, event.toolCallId, nextSession, now, state.iteration),
        };
      }
      break;
    }

    case 'agent_completed': {
      const agentSessions = new Map(state.agentSessions);
      const entry = agentSessions.get(event.toolCallId);
      if (entry) {
        const nextSession = {
          ...entry,
          status: event.isError ? 'error' : 'completed',
          iterations: event.iterations,
          toolCallCount: event.toolCallCount,
        } satisfies AgentSessionSummary;
        agentSessions.set(event.toolCallId, nextSession);
        nextState = {
          ...state,
          agentSessions,
          activity: upsertAgentActivity(state.activity, event.toolCallId, nextSession, now, state.iteration),
        };
      }
      break;
    }

    case 'user_question': {
      const existing =
        state.pendingQuestion?.toolCallId === event.toolCallId ? state.pendingQuestion : undefined;
      nextState = {
        ...state,
        status: 'awaiting_user',
        pendingQuestion: { ...existing, toolCallId: event.toolCallId, question: event.question },
      };
      break;
    }

    case 'user_request': {
      nextState = {
        ...state,
        status: 'awaiting_user',
        pendingQuestion: {
          toolCallId: event.request.requestId,
          question: event.request.prompt,
          kind: event.request.kind,
          allowedResponses: event.request.allowedResponses,
          context: event.request.context,
        },
      };
      break;
    }

    case 'user_answer': {
      if (state.status === 'awaiting_user') {
        nextState = {
          ...state,
          status: 'running',
          pendingQuestion: null,
        };
      }
      break;
    }

    case 'steered':
    case 'follow_up':
    case 'context_overflow':
    case 'turn_end': {
      break;
    }
  }

  return { state: nextState, turnStartTime, totalStartTime };
}
