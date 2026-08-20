export type WorkbenchContributionArea = 'side-pane';

export type WorkbenchContributionContent =
  | { kind: 'activity' }
  | { kind: 'context' };

export interface WorkbenchContribution {
  id: string;
  area: WorkbenchContributionArea;
  label: string;
  order: number;
  content: WorkbenchContributionContent;
}

export class WorkbenchContributionRegistry {
  readonly #entries = new Map<string, WorkbenchContribution>();
  readonly #listeners = new Set<() => void>();
  #snapshot: WorkbenchContribution[] = [];

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): WorkbenchContribution[] => this.#snapshot;

  register(contribution: WorkbenchContribution): () => void {
    if (!contribution.id.trim()) throw new Error('Workbench contribution id is required');
    if (this.#entries.has(contribution.id)) {
      throw new Error(`Workbench contribution already registered: ${contribution.id}`);
    }
    this.#entries.set(contribution.id, freezeContribution(contribution));
    this.#publish();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.#entries.delete(contribution.id);
      this.#publish();
    };
  }

  #publish(): void {
    this.#snapshot = [...this.#entries.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // One consumer cannot break contribution registration or disposal.
      }
    }
  }
}

export function createDefaultWorkbenchRegistry(): WorkbenchContributionRegistry {
  const registry = new WorkbenchContributionRegistry();
  registry.register({ id: 'activity', area: 'side-pane', label: 'Activity', order: 10, content: { kind: 'activity' } });
  registry.register({ id: 'context', area: 'side-pane', label: 'Context', order: 20, content: { kind: 'context' } });
  return registry;
}

function freezeContribution(contribution: WorkbenchContribution): WorkbenchContribution {
  return Object.freeze({ ...contribution, content: Object.freeze({ ...contribution.content }) });
}
