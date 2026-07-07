import type {
  AgentState,
  SerializedAgentState,
  ToolCallEntry,
  SerializedToolCallEntry,
  AgentSessionSummary,
  SerializedAgentSessionSummary,
  ActivityEntry,
  SerializedActivityEntry,
} from './types.js';

function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return String(value);
  }
}

function serializeToolCall(entry: ToolCallEntry): SerializedToolCallEntry {
  const result: SerializedToolCallEntry = {
    toolName: entry.toolName,
    input: safeStringify(entry.input),
    status: entry.status,
  };
  if (entry.result !== undefined) result.result = safeStringify(entry.result);
  if (entry.isError !== undefined) result.isError = entry.isError;
  if (entry.progress !== undefined) result.progress = entry.progress;
  if (entry.details !== undefined) result.details = safeStringify(entry.details);
  return result;
}

function deserializeToolCall(entry: SerializedToolCallEntry): ToolCallEntry {
  let input: unknown = entry.input;
  try { input = JSON.parse(entry.input); } catch { /* keep as string */ }
  const result: ToolCallEntry = {
    toolName: entry.toolName,
    input,
    status: entry.status,
  };
  if (entry.result !== undefined) {
    try { result.result = JSON.parse(entry.result); } catch { result.result = entry.result; }
  }
  if (entry.isError !== undefined) result.isError = entry.isError;
  if (entry.progress !== undefined) result.progress = entry.progress;
  if (entry.details !== undefined) {
    try { result.details = JSON.parse(entry.details); } catch { result.details = entry.details; }
  }
  return result;
}

function serializeSession(s: AgentSessionSummary): SerializedAgentSessionSummary {
  return { ...s };
}

function deserializeSession(s: SerializedAgentSessionSummary): AgentSessionSummary {
  return { ...s };
}

function serializeActivity(entry: ActivityEntry): SerializedActivityEntry {
  if (entry.kind === 'tool') {
    return {
      kind: 'tool',
      id: entry.id,
      timestamp: entry.timestamp,
      iteration: entry.iteration,
      entry: serializeToolCall(entry.entry),
    };
  }
  return {
    kind: 'agent',
    id: entry.id,
    timestamp: entry.timestamp,
    iteration: entry.iteration,
    session: serializeSession(entry.session),
  };
}

function deserializeActivity(entry: SerializedActivityEntry): ActivityEntry {
  if (entry.kind === 'tool') {
    return {
      kind: 'tool',
      id: entry.id,
      timestamp: entry.timestamp,
      iteration: entry.iteration,
      entry: deserializeToolCall(entry.entry),
    };
  }
  return {
    kind: 'agent',
    id: entry.id,
    timestamp: entry.timestamp,
    iteration: entry.iteration,
    session: deserializeSession(entry.session),
  };
}

/** Convert AgentState to a JSON-safe serialized form. */
export function serializeAgentState(state: AgentState): SerializedAgentState {
  const toolCalls: Record<string, SerializedToolCallEntry> = {};
  for (const [key, value] of state.toolCalls) {
    toolCalls[key] = serializeToolCall(value);
  }
  const agentSessions: Record<string, SerializedAgentSessionSummary> = {};
  for (const [key, value] of state.agentSessions) {
    agentSessions[key] = serializeSession(value);
  }
  return {
    sessionId: state.sessionId,
    messages: state.messages,
    iteration: state.iteration,
    toolCalls,
    tokenUsage: state.tokenUsage,
    contextUsage: state.contextUsage,
    totalElapsed: state.totalElapsed,
    elapsed: state.elapsed,
    status: state.status,
    error: state.error,
    agentSessions,
    activity: state.activity.map(serializeActivity),
    pendingQuestion: state.pendingQuestion,
  };
}

/** Convert a serialized state back to AgentState with Map fields. */
export function deserializeAgentState(serialized: SerializedAgentState): AgentState {
  const toolCalls = new Map<string, ToolCallEntry>();
  for (const [key, value] of Object.entries(serialized.toolCalls)) {
    toolCalls.set(key, deserializeToolCall(value));
  }
  const agentSessions = new Map<string, AgentSessionSummary>();
  for (const [key, value] of Object.entries(serialized.agentSessions)) {
    agentSessions.set(key, deserializeSession(value));
  }
  return {
    sessionId: serialized.sessionId,
    messages: serialized.messages,
    iteration: serialized.iteration,
    toolCalls,
    tokenUsage: serialized.tokenUsage,
    contextUsage: serialized.contextUsage,
    totalElapsed: serialized.totalElapsed,
    elapsed: serialized.elapsed,
    status: serialized.status,
    error: serialized.error,
    agentSessions,
    activity: (serialized.activity ?? []).map(deserializeActivity),
    pendingQuestion: serialized.pendingQuestion,
  };
}
