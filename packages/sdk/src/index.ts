import type {
  LanguageMessage,
  LanguageTool,
  LanguageToolCallContent,
  LanguageToolResultContent,
  LanguageTokenUsage,
} from '@synax-ai/sdk';

export type { LanguageMessage, LanguageTool, LanguageToolCallContent, LanguageToolResultContent };

// --- Tool ---

export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  reportProgress?: (text: string) => void;
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

// --- Events ---

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolCall: LanguageToolCallContent }
  | { type: 'tool_progress'; toolCallId: string; text: string }
  | { type: 'tool_result'; toolCallId: string; result: unknown; isError?: boolean }
  | { type: 'steered'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'error'; error: Error }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number } };

// --- Controller ---

export interface AgentController {
  steer(message: string | LanguageMessage): void;
  followUp(message: string | LanguageMessage): void;
  abort(reason?: string): void;
  readonly isSteered: boolean;
  readonly isAborted: boolean;
  readonly hasFollowUps: boolean;
  consumeFollowUps(): LanguageMessage[];
}

export class AgentLoopController implements AgentController {
  private _steer?: LanguageMessage;
  private _followUps: LanguageMessage[] = [];
  private _aborted = false;
  private _abortReason?: string;

  private toMsg(m: string | LanguageMessage): LanguageMessage {
    return typeof m === 'string' ? { role: 'user', content: m } : m;
  }

  steer(message: string | LanguageMessage): void { this._steer = this.toMsg(message); }
  followUp(message: string | LanguageMessage): void { this._followUps.push(this.toMsg(message)); }
  abort(reason?: string): void { this._aborted = true; this._abortReason = reason; }

  get isSteered(): boolean { return this._steer !== undefined; }
  get isAborted(): boolean { return this._aborted; }
  get abortReason(): string | undefined { return this._abortReason; }
  get hasFollowUps(): boolean { return this._followUps.length > 0; }

  consumeSteer(): LanguageMessage | undefined {
    const m = this._steer; this._steer = undefined; return m;
  }
  consumeFollowUps(): LanguageMessage[] {
    const m = this._followUps; this._followUps = []; return m;
  }
}

// --- Config ---

export interface AgentConfig {
  model: string;
  system?: string;
  tools?: Tool[];
  maxIterations?: number;
  maxOutputTokens?: number;
  temperature?: number;
  workingDirectory?: string;
}
