import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AgentRunCheckpoint } from '@cortx/sdk';
import { AGENT_RUN_CHECKPOINT_SCHEMA_VERSION } from '@cortx/sdk';
import {
  RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION,
  RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION,
  type RuntimeDurableRunStore,
  type RuntimeSessionSnapshot,
  type RuntimeSubAgentSessionSnapshot,
} from './types.js';

export interface FileDurableRunStoreOptions {
  root: string;
}

export class FileDurableRunStore implements RuntimeDurableRunStore {
  private readonly root: string;
  private readonly subAgentWrites = new Map<string, Promise<void>>();

  constructor(options: FileDurableRunStoreOptions | string) {
    this.root = resolve(typeof options === 'string' ? options : options.root);
  }

  async saveCheckpoint(checkpoint: AgentRunCheckpoint): Promise<void> {
    await writeJson(this.checkpointPath(checkpoint.sessionId), checkpoint);
  }

  async loadCheckpoint(sessionId: string): Promise<AgentRunCheckpoint | undefined> {
    return readJson(this.checkpointPath(sessionId), isAgentRunCheckpoint);
  }

  async listCheckpoints(): Promise<AgentRunCheckpoint[]> {
    return listJson(join(this.root, 'checkpoints'), isAgentRunCheckpoint);
  }

  async deleteCheckpoint(sessionId: string): Promise<void> {
    await rm(this.checkpointPath(sessionId), { force: true });
  }

  async saveRuntimeSession(snapshot: RuntimeSessionSnapshot): Promise<void> {
    await writeJson(this.sessionPath(snapshot.id), snapshot);
  }

  async loadRuntimeSession(sessionId: string): Promise<RuntimeSessionSnapshot | undefined> {
    return readJson(this.sessionPath(sessionId), isRuntimeSessionSnapshot);
  }

  async listRuntimeSessions(): Promise<RuntimeSessionSnapshot[]> {
    return listJson(join(this.root, 'sessions'), isRuntimeSessionSnapshot);
  }

  async deleteRuntimeSession(sessionId: string): Promise<void> {
    await rm(this.sessionPath(sessionId), { force: true });
    await this.deleteCheckpoint(sessionId);
    await this.deleteSubAgentSessions(sessionId);
  }

  async saveSubAgentSession(snapshot: RuntimeSubAgentSessionSnapshot): Promise<void> {
    const path = this.subAgentPath(snapshot.parentSessionId, snapshot.toolCallId);
    const previous = this.subAgentWrites.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const existing = await readJson(path, isRuntimeSubAgentSessionSnapshot);
        if (existing && existing.status !== 'running' && snapshot.status === 'running') return;
        await writeJson(path, snapshot);
      });
    const queued = next.finally(() => {
      if (this.subAgentWrites.get(path) === queued) this.subAgentWrites.delete(path);
    });
    this.subAgentWrites.set(path, queued);
    await next;
  }

  async listSubAgentSessions(parentSessionId: string): Promise<RuntimeSubAgentSessionSnapshot[]> {
    return listJson(join(this.root, 'sub-agents', encodeId(parentSessionId)), isRuntimeSubAgentSessionSnapshot);
  }

  async deleteSubAgentSessions(parentSessionId: string): Promise<void> {
    await rm(join(this.root, 'sub-agents', encodeId(parentSessionId)), { recursive: true, force: true });
  }

  private checkpointPath(sessionId: string): string {
    return join(this.root, 'checkpoints', `${encodeId(sessionId)}.json`);
  }

  private sessionPath(sessionId: string): string {
    return join(this.root, 'sessions', `${encodeId(sessionId)}.json`);
  }

  private subAgentPath(parentSessionId: string, toolCallId: string): string {
    return join(this.root, 'sub-agents', encodeId(parentSessionId), `${encodeId(toolCallId)}.json`);
  }
}

function encodeId(value: string): string {
  return Buffer.from(value).toString('base64url');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await rename(temp, path);
}

async function readJson<T>(path: string, guard: (value: unknown) => value is T): Promise<T | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return guard(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function listJson<T>(dir: string, guard: (value: unknown) => value is T): Promise<T[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const records: T[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const record = await readJson(join(dir, file), guard);
    if (record) records.push(record);
  }
  return records;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentRunCheckpoint(value: unknown): value is AgentRunCheckpoint {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === AGENT_RUN_CHECKPOINT_SCHEMA_VERSION &&
    typeof value.sessionId === 'string' &&
    typeof value.iteration === 'number' &&
    isObject(value.state)
  );
}

function isRuntimeSessionSnapshot(value: unknown): value is RuntimeSessionSnapshot {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === RUNTIME_SESSION_SNAPSHOT_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.lastActivityAt === 'number' &&
    typeof value.workingDirectory === 'string' &&
    typeof value.model === 'string' &&
    typeof value.toolMode === 'string' &&
    typeof value.approvalMode === 'string' &&
    isObject(value.capabilities) &&
    typeof value.runId === 'number' &&
    typeof value.nextEventSequence === 'number'
  );
}

function isRuntimeSubAgentSessionSnapshot(value: unknown): value is RuntimeSubAgentSessionSnapshot {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === RUNTIME_SUB_AGENT_SESSION_SNAPSHOT_SCHEMA_VERSION &&
    typeof value.runId === 'string' &&
    typeof value.parentSessionId === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.description === 'string' &&
    typeof value.isBackground === 'boolean' &&
    (value.status === 'running' || value.status === 'completed' || value.status === 'error') &&
    typeof value.output === 'string' &&
    typeof value.iterations === 'number' &&
    typeof value.toolCallCount === 'number' &&
    typeof value.startedAt === 'number'
  );
}
