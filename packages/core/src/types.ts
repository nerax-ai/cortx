import type { LanguageMessage } from '@synax-ai/sdk';
import type {
  AgentDurableRunStore,
  AgentRunLimits,
  AgentRunRecorder,
  AgentTracer,
  Logger,
  AgentEvent,
  Tool,
  ErrorCode,
  CortxExtensionType,
  CortxFactoryMap,
} from '@cortx/sdk';
import type { PluginRegistry } from '@nerax-ai/plugin';

export type { AgentEvent, ErrorCode, CortxExtensionType, CortxFactoryMap };

export type DeliveryMode = 'all' | 'one-at-a-time';

export interface AgentController {
  steer(message: string | LanguageMessage): void;
  followUp(message: string | LanguageMessage): void;
  abort(reason?: string): void;
  answerUser(toolCallId: string, response: string): void;
  rejectPendingQuestions(reason: string): void;
  readonly isSteered: boolean;
  readonly isAborted: boolean;
  readonly hasFollowUps: boolean;
  readonly abortReason?: string;
  steeringMode: DeliveryMode;
  followUpMode: DeliveryMode;
  consumeSteering(): LanguageMessage[];
  consumeFollowUps(): LanguageMessage[];
  onAbort?(listener: (reason?: string) => void): () => void;
}

export class AgentLoopController implements AgentController {
  private _steer: LanguageMessage[] = [];
  private _followUps: LanguageMessage[] = [];
  private _aborted = false;
  private _abortReason?: string;
  private _pendingQuestions = new Map<
    string,
    { resolve: (response: string) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  private _abortListeners = new Set<(reason?: string) => void>();
  steeringMode: DeliveryMode = 'one-at-a-time';
  followUpMode: DeliveryMode = 'one-at-a-time';

  private toMsg(m: string | LanguageMessage): LanguageMessage {
    return typeof m === 'string' ? { role: 'user', content: [{ type: 'text' as const, text: m }] } : m;
  }

  steer(message: string | LanguageMessage): void {
    this._steer.push(this.toMsg(message));
  }
  followUp(message: string | LanguageMessage): void {
    this._followUps.push(this.toMsg(message));
  }
  abort(reason?: string): void {
    if (this._aborted) return;
    this._aborted = true;
    this._abortReason = reason;
    this.rejectPendingQuestions(reason ?? 'aborted');
    for (const listener of this._abortListeners) {
      try {
        listener(reason);
      } catch {
        /* abort listeners must not throw into callers */
      }
    }
  }

  get isSteered(): boolean {
    return this._steer.length > 0;
  }
  get isAborted(): boolean {
    return this._aborted;
  }
  get abortReason(): string | undefined {
    return this._abortReason;
  }
  get hasFollowUps(): boolean {
    return this._followUps.length > 0;
  }

  /**
   * Register a pending askUser question. Returns a Promise that resolves
   * when answerUser() is called or rejects on timeout.
   */
  registerQuestion(toolCallId: string, timeoutMs = 120_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingQuestions.delete(toolCallId);
        reject(new Error(`askUser timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this._pendingQuestions.set(toolCallId, { resolve, reject, timeout });
    });
  }

  /**
   * Resolve a pending askUser question with the user's response.
   */
  answerUser(toolCallId: string, response: string): void {
    const pending = this._pendingQuestions.get(toolCallId);
    if (pending) {
      clearTimeout(pending.timeout);
      this._pendingQuestions.delete(toolCallId);
      pending.resolve(response);
    }
  }

  /**
   * Reject all pending askUser questions (e.g., on abort).
   */
  rejectPendingQuestions(reason: string): void {
    for (const [, pending] of this._pendingQuestions) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this._pendingQuestions.clear();
  }

  consumeSteering(): LanguageMessage[] {
    return this.steeringMode === 'one-at-a-time'
      ? this._steer.length
        ? [this._steer.shift()!]
        : []
      : this._steer.splice(0);
  }
  consumeFollowUps(): LanguageMessage[] {
    return this.followUpMode === 'one-at-a-time'
      ? this._followUps.length
        ? [this._followUps.shift()!]
        : []
      : this._followUps.splice(0);
  }

  onAbort(listener: (reason?: string) => void): () => void {
    this._abortListeners.add(listener);
    if (this._aborted) listener(this._abortReason);
    return () => this._abortListeners.delete(listener);
  }
}

export interface PluginConfig {
  use: string;
  options?: Record<string, unknown>;
}

export type CortxRegistry = PluginRegistry<CortxExtensionType, CortxFactoryMap>;

export interface CortxConfig {
  model: string;
  system?: string;
  tools?: Tool[];
  appName?: string;
  registry?: CortxRegistry;
  plugins?: PluginConfig[];
  logger?: Logger;
  askUser?: (question: string) => Promise<string>;
  maxIterations?: number;
  maxOutputTokens?: number;
  temperature?: number;
  limits?: AgentRunLimits;
  tracer?: AgentTracer;
  recorder?: AgentRunRecorder;
  durableStore?: AgentDurableRunStore;
  workingDirectory?: string;
  autoContinueLimit?: number;
  toolResultBudget?: number;
  maxConcurrentTools?: number;
  maxConcurrentAgents?: number;
  skillPaths?: string[];
  capabilities?: {
    skills?: 'enabled' | 'disabled';
    subAgents?: 'enabled' | 'disabled';
  };
  safety?: {
    toolApproval?: 'enabled' | 'disabled';
  };
}
