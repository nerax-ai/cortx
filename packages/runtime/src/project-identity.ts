import { resolveRuntimeDomainIdentity, type RuntimeDomainIdentityMode } from '@nerax-ai/plugin';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ProjectIdentityRecord {
  schemaVersion: 1;
  runtimeDomainId: string;
  updatedAt: string;
}

export interface ProjectIdentityAuditEvent {
  action: RuntimeDomainIdentityMode;
  projectRoot: string;
  runtimeDomainId: string;
}

export interface ProjectIdentityStoreOptions {
  projectRoot: string;
  metadataPath?: string;
  audit?(event: ProjectIdentityAuditEvent): void;
}

export class ProjectIdentityStore {
  readonly projectRoot: string;
  readonly metadataPath: string;
  readonly #audit?: ProjectIdentityStoreOptions['audit'];

  constructor(options: ProjectIdentityStoreOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.metadataPath = options.metadataPath ?? join(this.projectRoot, '.cortx', 'project-domain.json');
    this.#audit = options.audit;
  }

  read(): ProjectIdentityRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(this.metadataPath, 'utf8')) as Partial<ProjectIdentityRecord>;
      if (value.schemaVersion !== 1 || typeof value.runtimeDomainId !== 'string' || !value.runtimeDomainId.trim()) {
        throw new Error(`Invalid Cortx project identity: ${this.metadataPath}`);
      }
      return {
        schemaVersion: 1,
        runtimeDomainId: value.runtimeDomainId,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  resolve(input: {
    mode: RuntimeDomainIdentityMode;
    importedRuntimeDomainId?: string;
    claimedRuntimeDomainIds?: readonly string[];
    generate?: () => string;
  }): { runtimeDomainId: string } {
    const stored = this.read();
    if (input.mode === 'create' && stored) {
      throw new Error(`Project identity already exists: ${this.metadataPath}`);
    }
    const identity = resolveRuntimeDomainIdentity({
      mode: input.mode,
      storedRuntimeDomainId: stored?.runtimeDomainId,
      importedRuntimeDomainId: input.importedRuntimeDomainId,
      claimedRuntimeDomainIds: input.claimedRuntimeDomainIds,
      generate: input.generate ?? (() => `cortx:${crypto.randomUUID()}`),
    });
    const runtimeDomainId =
      input.mode === 'create' ? this.#persistCreate(identity.runtimeDomainId) : this.#persist(identity.runtimeDomainId);
    this.#audit?.({ action: input.mode, projectRoot: this.projectRoot, runtimeDomainId });
    return { runtimeDomainId };
  }

  #persist(runtimeDomainId: string): string {
    const temporary = this.#writeTemporary(runtimeDomainId);
    renameSync(temporary, this.metadataPath);
    return runtimeDomainId;
  }

  #persistCreate(runtimeDomainId: string): string {
    const temporary = this.#writeTemporary(runtimeDomainId);
    try {
      linkSync(temporary, this.metadataPath);
      return runtimeDomainId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = this.read();
      if (!winner) throw new Error(`Competing Cortx project identity disappeared: ${this.metadataPath}`);
      return winner.runtimeDomainId;
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  #writeTemporary(runtimeDomainId: string): string {
    const record: ProjectIdentityRecord = {
      schemaVersion: 1,
      runtimeDomainId,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.metadataPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return temporary;
  }
}
