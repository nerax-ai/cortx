import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  parseAgentRunCheckpoint,
  parseRuntimeEventEnvelopeSnapshot,
  parseRuntimeSessionSnapshot,
  parseRuntimeSubAgentSessionSnapshot,
  serializeRuntimeEventEnvelopeSnapshot,
} from './migrations.js';
import type { AgentRunCheckpoint } from '@cortx/sdk';
import type {
  RuntimeDurableRunStore,
  RuntimeEventEnvelopeSnapshot,
  RuntimeSessionSnapshot,
  RuntimeSubAgentSessionSnapshot,
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
    return readJson(this.checkpointPath(sessionId), parseAgentRunCheckpoint);
  }

  async listCheckpoints(): Promise<AgentRunCheckpoint[]> {
    return listJson(join(this.root, 'checkpoints'), parseAgentRunCheckpoint);
  }

  async deleteCheckpoint(sessionId: string): Promise<void> {
    await rm(this.checkpointPath(sessionId), { force: true });
  }

  async saveRuntimeSession(snapshot: RuntimeSessionSnapshot): Promise<void> {
    await writeJson(this.sessionPath(snapshot.id), snapshot);
  }

  async loadRuntimeSession(sessionId: string): Promise<RuntimeSessionSnapshot | undefined> {
    return readJson(this.sessionPath(sessionId), parseRuntimeSessionSnapshot);
  }

  async listRuntimeSessions(): Promise<RuntimeSessionSnapshot[]> {
    return listJson(join(this.root, 'sessions'), parseRuntimeSessionSnapshot);
  }

  async deleteRuntimeSession(sessionId: string): Promise<void> {
    await rm(this.sessionPath(sessionId), { force: true });
    await this.deleteCheckpoint(sessionId);
    await this.deleteSubAgentSessions(sessionId);
    await this.deleteEventEnvelopes(sessionId);
  }

  async saveSubAgentSession(snapshot: RuntimeSubAgentSessionSnapshot): Promise<void> {
    const path = this.subAgentPath(snapshot.parentSessionId, snapshot.toolCallId);
    const previous = this.subAgentWrites.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const existing = await readJson(path, parseRuntimeSubAgentSessionSnapshot);
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
    return listJson(join(this.root, 'sub-agents', encodeId(parentSessionId)), parseRuntimeSubAgentSessionSnapshot);
  }

  async deleteSubAgentSessions(parentSessionId: string): Promise<void> {
    await rm(join(this.root, 'sub-agents', encodeId(parentSessionId)), { recursive: true, force: true });
  }

  async saveEventEnvelope(snapshot: RuntimeEventEnvelopeSnapshot): Promise<void> {
    await writeJson(this.eventEnvelopePath(snapshot.sessionId, snapshot.sequence), serializeRuntimeEventEnvelopeSnapshot(snapshot));
  }

  async listEventEnvelopes(sessionId: string): Promise<RuntimeEventEnvelopeSnapshot[]> {
    const records = await listJson(join(this.root, 'events', encodeId(sessionId)), parseRuntimeEventEnvelopeSnapshot);
    return records.sort((a, b) => a.sequence - b.sequence);
  }

  async deleteEventEnvelopes(sessionId: string): Promise<void> {
    await rm(join(this.root, 'events', encodeId(sessionId)), { recursive: true, force: true });
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

  private eventEnvelopePath(sessionId: string, sequence: number): string {
    return join(this.root, 'events', encodeId(sessionId), `${String(sequence).padStart(16, '0')}.json`);
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

async function readJson<T>(path: string, parse: (value: unknown) => T | undefined): Promise<T | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parse(value);
  } catch {
    return undefined;
  }
}

async function listJson<T>(dir: string, parse: (value: unknown) => T | undefined): Promise<T[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const records: T[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const record = await readJson(join(dir, file), parse);
    if (record) records.push(record);
  }
  return records;
}
