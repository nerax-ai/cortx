import type { AgentEvent } from '@cortx/sdk';
import type {
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
      const turnDuration = turnStartTime > 0 ? (now - turnStartTime) / 1000 : 0;
      if (prev.currentText.length > 0) {
        turns = [...turns, { role: 'assistant', content: prev.currentText, timestamp: now, duration: turnDuration } satisfies TurnEntry];
      } else if (turnDuration > 0 && turns.length > 0) {
        const last = turns[turns.length - 1];
        if (!last.duration) turns[turns.length - 1] = { ...last, duration: turnDuration };
      }
      const prevElapsed = turnStartTime > 0 ? state.elapsed : 0;
      nextState = {
        ...state,
        iteration: event.iteration,
        status: 'running',
        messages: { turns, currentText: '', currentThinking: '' },
        toolCalls: new Map(),
        totalElapsed: state.totalElapsed + prevElapsed,
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
      toolCalls.set(event.toolCall.toolCallId, {
        toolName: event.toolCall.toolName,
        input: event.toolCall.input,
        status: 'pending',
      } satisfies ToolCallEntry);
      nextState = {
        ...state,
        messages: { turns, currentText: '', currentThinking: '' },
        toolCalls,
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
        nextState = { ...state, toolCalls };
      }
      break;
    }

    case 'tool_result': {
      const toolCalls = new Map(state.toolCalls);
      const entry = toolCalls.get(event.toolCallId);
      if (entry) {
        toolCalls.set(event.toolCallId, {
          ...entry,
          result: event.result,
          isError: event.isError,
          status: 'complete',
        });
      }
      nextState = { ...state, toolCalls };
      break;
    }

    case 'done': {
      const usage: TokenUsage = event.usage
        ? {
            inputTokens: state.tokenUsage.inputTokens + event.usage.inputTokens,
            outputTokens: state.tokenUsage.outputTokens + event.usage.outputTokens,
          }
        : state.tokenUsage;
      const prev = state.messages;
      const turns =
        prev.currentText.length > 0
          ? [...prev.turns, { role: 'assistant', content: prev.currentText, timestamp: now } satisfies TurnEntry]
          : [...prev.turns];
      nextState = {
        ...state,
        status: 'idle',
        messages: { turns, currentText: '', currentThinking: '' },
        tokenUsage: usage,
        totalElapsed: state.totalElapsed + state.elapsed,
        elapsed: 0,
      };
      turnStartTime = 0;
      break;
    }

    case 'error': {
      const prev = state.messages;
      const turns =
        prev.currentText.length > 0
          ? [...prev.turns, { role: 'assistant', content: prev.currentText, timestamp: now } satisfies TurnEntry]
          : [...prev.turns];
      nextState = {
        ...state,
        status: 'error',
        messages: { turns, currentText: '', currentThinking: '' },
        error: event.error.message,
        elapsed: 0,
      };
      break;
    }

    case 'agent_started': {
      const agentSessions = new Map(state.agentSessions);
      agentSessions.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        description: event.description,
        status: 'running',
        isBackground: event.isBackground ?? false,
        iterations: 0,
        toolCallCount: 0,
      } satisfies AgentSessionSummary);
      nextState = { ...state, agentSessions };
      break;
    }

    case 'agent_progress': {
      const agentSessions = new Map(state.agentSessions);
      const entry = agentSessions.get(event.toolCallId);
      if (entry) {
        agentSessions.set(event.toolCallId, {
          ...entry,
          progress: event.text,
        });
        nextState = { ...state, agentSessions };
      }
      break;
    }

    case 'agent_completed': {
      const agentSessions = new Map(state.agentSessions);
      const entry = agentSessions.get(event.toolCallId);
      if (entry) {
        agentSessions.set(event.toolCallId, {
          ...entry,
          status: event.isError ? 'error' : 'completed',
          iterations: event.iterations,
          toolCallCount: event.toolCallCount,
        });
        nextState = { ...state, agentSessions };
      }
      break;
    }

    case 'user_question': {
      nextState = {
        ...state,
        status: 'awaiting_user',
        pendingQuestion: { toolCallId: event.toolCallId, question: event.question },
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
