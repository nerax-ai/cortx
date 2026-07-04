import type { AgentDurableRunStore, AgentRunCheckpoint } from '@cortx/sdk';

export class MemoryDurableRunStore implements AgentDurableRunStore {
  private readonly checkpoints = new Map<string, AgentRunCheckpoint>();

  saveCheckpoint(checkpoint: AgentRunCheckpoint): void {
    this.checkpoints.set(checkpoint.sessionId, checkpoint);
  }

  loadCheckpoint(sessionId: string): AgentRunCheckpoint | undefined {
    return this.checkpoints.get(sessionId);
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.checkpoints.delete(sessionId);
      return;
    }
    this.checkpoints.clear();
  }
}
