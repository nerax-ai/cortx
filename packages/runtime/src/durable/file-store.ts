import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
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
import type { RuntimeEventRetention } from '../session.js';

export interface FileDurableRunStoreOptions {
  root: string;
  maxEventEnvelopesPerSession?: number;
}

const DEFAULT_MAX_EVENT_ENVELOPES_PER_SESSION = 10_000;

export class FileDurableRunStore implements RuntimeDurableRunStore {
  private readonly root: string;
  private readonly maxEventEnvelopesPerSession: number;
  private readonly subAgentWrites = new Map<string, Promise<void>>();
  private readonly eventRetention = new Map<string, RuntimeEventRetention>();
  private readonly ownerToken = randomUUID();
  private ownsRoot = false;

  constructor(options: FileDurableRunStoreOptions | string) {
    this.root = resolve(typeof options === 'string' ? options : options.root);
    this.maxEventEnvelopesPerSession = normalizeEventLimit(
      typeof options === 'string' ? undefined : options.maxEventEnvelopesPerSession,
    );
  }

  acquireOwnership(): void {
    if (this.ownsRoot) return;
    mkdirSync(this.root, { recursive: true });
    const path = this.ownerLockPath();
    let descriptor: number;
    try {
      descriptor = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      const owner = readOwnerLock(path);
      throw new Error(
        `Durable root is already owned: ${this.root}${owner ? ` (pid ${owner.pid} on ${owner.hostname})` : ''}. ` +
        'Stop the other Runtime or remove the stale owner lock after verifying no writer is active.',
        { cause: error },
      );
    }
    try {
      writeFileSync(descriptor, JSON.stringify({
        token: this.ownerToken,
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: Date.now(),
      }), 'utf8');
      this.ownsRoot = true;
    } finally {
      closeSync(descriptor);
    }
  }

  releaseOwnership(): void {
    if (!this.ownsRoot) return;
    const path = this.ownerLockPath();
    const owner = readOwnerLock(path);
    if (!owner || owner.token !== this.ownerToken) {
      throw new Error(`Durable root ownership changed before release: ${this.root}`);
    }
    rmSync(path, { force: true });
    this.ownsRoot = false;
  }

  close(): void {
    this.releaseOwnership();
  }

  async saveCheckpoint(checkpoint: AgentRunCheckpoint): Promise<void> {
    this.acquireOwnership();
    await writeJson(this.checkpointPath(checkpoint.sessionId), checkpoint);
  }

  async loadCheckpoint(sessionId: string): Promise<AgentRunCheckpoint | undefined> {
    return readJson(this.checkpointPath(sessionId), parseAgentRunCheckpoint);
  }

  async listCheckpoints(): Promise<AgentRunCheckpoint[]> {
    return listJson(join(this.root, 'checkpoints'), parseAgentRunCheckpoint);
  }

  async deleteCheckpoint(sessionId: string): Promise<void> {
    this.acquireOwnership();
    await rm(this.checkpointPath(sessionId), { force: true });
  }

  async saveRuntimeSession(snapshot: RuntimeSessionSnapshot): Promise<void> {
    this.acquireOwnership();
    await writeJson(this.sessionPath(snapshot.id), snapshot);
  }

  async loadRuntimeSession(sessionId: string): Promise<RuntimeSessionSnapshot | undefined> {
    return readJson(this.sessionPath(sessionId), parseRuntimeSessionSnapshot);
  }

  async listRuntimeSessions(): Promise<RuntimeSessionSnapshot[]> {
    return listJson(join(this.root, 'sessions'), parseRuntimeSessionSnapshot);
  }

  async deleteRuntimeSession(sessionId: string): Promise<void> {
    this.acquireOwnership();
    await rm(this.sessionPath(sessionId), { force: true });
    await this.deleteCheckpoint(sessionId);
    await this.deleteSubAgentSessions(sessionId);
    await this.deleteEventEnvelopes(sessionId);
  }

  async saveSubAgentSession(snapshot: RuntimeSubAgentSessionSnapshot): Promise<void> {
    this.acquireOwnership();
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
    this.acquireOwnership();
    await rm(join(this.root, 'sub-agents', encodeId(parentSessionId)), { recursive: true, force: true });
  }

  async saveEventEnvelope(snapshot: RuntimeEventEnvelopeSnapshot): Promise<void> {
    this.acquireOwnership();
    await writeJson(this.eventEnvelopePath(snapshot.sessionId, snapshot.sequence), serializeRuntimeEventEnvelopeSnapshot(snapshot));
    this.eventRetention.set(snapshot.sessionId, await this.pruneEventEnvelopes(snapshot.sessionId));
  }

  async listEventEnvelopes(sessionId: string): Promise<RuntimeEventEnvelopeSnapshot[]> {
    const records = await listJson(join(this.root, 'events', encodeId(sessionId)), parseRuntimeEventEnvelopeSnapshot);
    return records.sort((a, b) => a.sequence - b.sequence);
  }

  async deleteEventEnvelopes(sessionId: string): Promise<void> {
    this.acquireOwnership();
    await rm(join(this.root, 'events', encodeId(sessionId)), { recursive: true, force: true });
    this.eventRetention.delete(sessionId);
  }

  async getEventEnvelopeRetention(sessionId: string): Promise<RuntimeEventRetention> {
    const cached = this.eventRetention.get(sessionId);
    if (cached) return { ...cached };
    const retention = await this.readEventEnvelopeRetention(sessionId);
    this.eventRetention.set(sessionId, retention);
    return { ...retention };
  }

  private checkpointPath(sessionId: string): string {
    return join(this.root, 'checkpoints', `${encodeId(sessionId)}.json`);
  }

  private ownerLockPath(): string {
    return join(this.root, '.runtime-owner.lock');
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

  private async pruneEventEnvelopes(sessionId: string): Promise<RuntimeEventRetention> {
    const dir = join(this.root, 'events', encodeId(sessionId));
    let files: string[];
    try {
      files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
    } catch {
      return { oldestAvailableSequence: null, lastAvailableSequence: 0 };
    }
    const stale = files.slice(0, Math.max(0, files.length - this.maxEventEnvelopesPerSession));
    await Promise.all(stale.map((file) => rm(join(dir, file), { force: true })));
    return retentionFromEventFiles(files.slice(stale.length));
  }

  private async readEventEnvelopeRetention(sessionId: string): Promise<RuntimeEventRetention> {
    try {
      const files = (await readdir(join(this.root, 'events', encodeId(sessionId))))
        .filter((file) => file.endsWith('.json'))
        .sort();
      return retentionFromEventFiles(files);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { oldestAvailableSequence: null, lastAvailableSequence: 0 };
      }
      throw error;
    }
  }
}

function retentionFromEventFiles(files: string[]): RuntimeEventRetention {
  return {
    oldestAvailableSequence: eventSequenceFromFile(files[0]),
    lastAvailableSequence: eventSequenceFromFile(files.at(-1)) ?? 0,
  };
}

function eventSequenceFromFile(file: string | undefined): number | null {
  if (!file) return null;
  const sequence = Number(file.slice(0, -'.json'.length));
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function normalizeEventLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_EVENT_ENVELOPES_PER_SESSION;
  if (!Number.isFinite(value)) return DEFAULT_MAX_EVENT_ENVELOPES_PER_SESSION;
  return Math.max(1, Math.floor(value));
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
    const parsed = parse(value);
    if (parsed === undefined) throw new Error(`Unsupported or invalid durable record: ${path}`);
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`Invalid durable JSON: ${path}`, { cause: error });
    throw error;
  }
}

async function listJson<T>(dir: string, parse: (value: unknown) => T | undefined): Promise<T[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }

  const records: T[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const record = await readJson(join(dir, file), parse);
    if (record) records.push(record);
  }
  return records;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

interface DurableRootOwner {
  token: string;
  pid: number;
  hostname: string;
}

function readOwnerLock(path: string): DurableRootOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<DurableRootOwner>;
    if (typeof value.token !== 'string' || typeof value.pid !== 'number' || typeof value.hostname !== 'string') {
      return undefined;
    }
    return { token: value.token, pid: value.pid, hostname: value.hostname };
  } catch {
    return undefined;
  }
}
