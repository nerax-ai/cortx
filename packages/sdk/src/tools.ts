import type { Logger } from '@nerax-ai/logger';

export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
  /** UI/host-only structured facts. Not included in the language tool result output. */
  details?: unknown;
}

export interface ToolContext {
  sessionId: string;
  runId?: number;
  toolCallId: string;
  workingDirectory: string;
  logger: Logger;
  signal?: AbortSignal;
  reportProgress?: (text: string) => void;
  askUser?: (question: string) => Promise<string>;
}

export type SideEffects = 'none' | 'read' | 'write' | 'destructive';

export interface Tool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  sideEffects?: SideEffects;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool<T extends Tool>(tool: T): T {
  return tool;
}
