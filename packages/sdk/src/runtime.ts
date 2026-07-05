import type { AgentEvent } from './events.js';
import type { LanguageMessage, LanguageToolResultContent } from '@synax-ai/sdk';

export const AGENT_RUN_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface AgentRunLimits {
  maxIterations?: number;
  maxRetries?: number;
  maxOverflowRecoveries?: number;
  turnTimeoutMs?: number;
  toolTimeoutMs?: number;
  tokenBudget?: number;
}

export interface AgentTraceSpan {
  name: string;
  attributes?: Record<string, unknown>;
  end(error?: unknown): void | Promise<void>;
}

export interface AgentTracer {
  startSpan(name: string, attributes?: Record<string, unknown>): AgentTraceSpan | Promise<AgentTraceSpan>;
}

export interface AgentRunRecorder {
  recordEvent(event: AgentEvent, context: AgentRecorderContext): void | Promise<void>;
  recordCheckpoint?(checkpoint: AgentRunCheckpoint): void | Promise<void>;
}

export interface AgentRecorderContext {
  sessionId: string;
  iteration: number;
  phase?: string;
}

export type AgentRunCheckpointKind = 'turn_start' | 'turn_end' | 'tool_result' | 'terminal';

export interface AgentRunCheckpoint {
  schemaVersion: typeof AGENT_RUN_CHECKPOINT_SCHEMA_VERSION;
  sessionId: string;
  runId?: number;
  iteration: number;
  kind: AgentRunCheckpointKind;
  state: AgentRunCheckpointState;
}

export interface AgentRunCheckpointState {
  phase: string;
  lastEvent: AgentEvent;
  terminal: boolean;
  messages?: LanguageMessage[];
  pendingToolResults?: LanguageToolResultContent[];
}

export interface AgentRunResumeState {
  sessionId: string;
  checkpoint: AgentRunCheckpoint;
}

export interface AgentDurableRunStore {
  saveCheckpoint(checkpoint: AgentRunCheckpoint): void | Promise<void>;
  loadCheckpoint(sessionId: string): AgentRunCheckpoint | undefined | Promise<AgentRunCheckpoint | undefined>;
  listCheckpoints?(): AgentRunCheckpoint[] | Promise<AgentRunCheckpoint[]>;
  deleteCheckpoint?(sessionId: string): void | Promise<void>;
}
