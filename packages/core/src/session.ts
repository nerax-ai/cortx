import type { AgentEvent, AgentController } from './types.js';
import type { LanguageMessage } from '@cortx/sdk';
import type { Cortx } from './agent.js';

export interface CortxState {
  isRunning: boolean;
  pendingToolCalls: Set<string>;
  error: string | undefined;
}

export class CortxSession {
  private readonly listeners = new Set<(e: AgentEvent) => void>();

  readonly state: CortxState = {
    isRunning: false,
    pendingToolCalls: new Set(),
    error: undefined,
  };

  constructor(readonly cortx: Cortx) {
    // Wire sub-agent lifecycle events into the parent event stream
    this.cortx.onAgentEvent = (event: AgentEvent) => {
      for (const fn of this.listeners) fn(event);
    };
  }

  get controller(): AgentController { return this.cortx.controller; }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async prompt(message: string | LanguageMessage): Promise<void> {
    await this._run(this.cortx.run(message));
  }

  async resume(): Promise<void> {
    await this._run(this.cortx.continue());
  }

  private async _run(gen: AsyncGenerator<AgentEvent>): Promise<void> {
    this.state.isRunning = true;
    this.state.error = undefined;
    try {
      for await (const event of gen) {
        if (event.type === 'tool_use') this.state.pendingToolCalls.add(event.toolCall.toolCallId);
        if (event.type === 'tool_result') this.state.pendingToolCalls.delete(event.toolCallId as string);
        if (event.type === 'error') this.state.error = event.error.message;
        for (const fn of this.listeners) fn(event);
      }
    } finally {
      this.state.isRunning = false;
      this.state.pendingToolCalls.clear();
    }
  }
}
