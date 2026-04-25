import type { LanguageMessage } from '@synax-ai/sdk';
import type { Logger, CortxPlugin, AgentEvent, Tool, ErrorCode } from '@cortx/sdk';

export type { CortxPlugin, AgentEvent, ErrorCode };

export type DeliveryMode = 'all' | 'one-at-a-time';

export interface AgentController {
  steer(message: string | LanguageMessage): void;
  followUp(message: string | LanguageMessage): void;
  abort(reason?: string): void;
  readonly isSteered: boolean;
  readonly isAborted: boolean;
  readonly hasFollowUps: boolean;
  readonly abortReason?: string;
  steeringMode: DeliveryMode;
  followUpMode: DeliveryMode;
  consumeSteering(): LanguageMessage[];
  consumeFollowUps(): LanguageMessage[];
}

export class AgentLoopController implements AgentController {
  private _steer: LanguageMessage[] = [];
  private _followUps: LanguageMessage[] = [];
  private _aborted = false;
  private _abortReason?: string;
  steeringMode: DeliveryMode = 'one-at-a-time';
  followUpMode: DeliveryMode = 'one-at-a-time';

  private toMsg(m: string | LanguageMessage): LanguageMessage {
    return typeof m === 'string' ? { role: 'user', content: [{ type: 'text' as const, text: m }] } : m;
  }

  steer(message: string | LanguageMessage): void { this._steer.push(this.toMsg(message)); }
  followUp(message: string | LanguageMessage): void { this._followUps.push(this.toMsg(message)); }
  abort(reason?: string): void { this._aborted = true; this._abortReason = reason; }

  get isSteered(): boolean { return this._steer.length > 0; }
  get isAborted(): boolean { return this._aborted; }
  get abortReason(): string | undefined { return this._abortReason; }
  get hasFollowUps(): boolean { return this._followUps.length > 0; }

  consumeSteering(): LanguageMessage[] {
    return this.steeringMode === 'one-at-a-time'
      ? (this._steer.length ? [this._steer.shift()!] : [])
      : this._steer.splice(0);
  }
  consumeFollowUps(): LanguageMessage[] {
    return this.followUpMode === 'one-at-a-time'
      ? (this._followUps.length ? [this._followUps.shift()!] : [])
      : this._followUps.splice(0);
  }
}

export interface PluginConfig {
  use: string;
  options?: Record<string, unknown>;
}

export type PluginEntry = CortxPlugin | PluginConfig;

export function isPluginConfig(p: PluginEntry): p is PluginConfig {
  return 'use' in p;
}

export interface CortxConfig {
  model: string;
  system?: string;
  tools?: Tool[];
  plugins?: PluginEntry[];
  logger?: Logger;
  askUser?: (question: string) => Promise<string>;
  maxIterations?: number;
  maxOutputTokens?: number;
  temperature?: number;
  workingDirectory?: string;
  autoContinueLimit?: number;
  toolResultBudget?: number;
  maxConcurrentTools?: number;
  maxConcurrentAgents?: number;
  skillPaths?: string[];
}
