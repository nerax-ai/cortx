import type { AgentDurableRunStore, AgentRunCheckpoint } from '@cortx/sdk';

export class MemoryDurableRunStore implements AgentDurableRunStore {
  private readonly checkpoints = new Map<string, AgentRunCheckpoint>();

  saveCheckpoint(checkpoint: AgentRunCheckpoint): void {
    this.checkpoints.set(checkpoint.sessionId, checkpoint);
  }

  loadCheckpoint(sessionId: string): AgentRunCheckpoint | undefined {
    return this.checkpoints.get(sessionId);
  }

  listCheckpoints(): AgentRunCheckpoint[] {
    return Array.from(this.checkpoints.values());
  }

  deleteCheckpoint(sessionId: string): void {
    this.checkpoints.delete(sessionId);
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.checkpoints.delete(sessionId);
      return;
    }
    this.checkpoints.clear();
  }
}
