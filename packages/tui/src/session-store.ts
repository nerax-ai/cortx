import { readdir, mkdir } from 'fs/promises';
import { getStorage, type StorageDir } from '@nerax-ai/storage';
import type { SessionMetadata, SessionSummary } from './plugins/session-plugin.js';

const SESSION_FILE_PREFIX = 'sess_';
const SESSION_FILE_SUFFIX = '.json';
const DEFAULT_MAX_SESSIONS = 50;

function sessionFilename(sessionId: string): string {
  return `${sessionId}${SESSION_FILE_SUFFIX}`;
}

function sessionIdFromFilename(filename: string): string | null {
  if (filename.startsWith(SESSION_FILE_PREFIX) && filename.endsWith(SESSION_FILE_SUFFIX)) {
    return filename.slice(0, -SESSION_FILE_SUFFIX.length);
  }
  return null;
}

function metadataToSummary(meta: SessionMetadata): SessionSummary {
  return {
    sessionId: meta.sessionId,
    model: meta.model,
    startTime: meta.startTime,
    lastUserMessage: meta.lastUserMessage,
    status: meta.status,
  };
}

export interface SessionStore {
  readonly path: string;
  listFiles(): Promise<string[]>;
  read(sessionId: string): Promise<SessionMetadata | null>;
  write(metadata: SessionMetadata): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<SessionSummary[]>;
  findCrashed(): Promise<SessionSummary[]>;
  cleanup(maxSessions?: number): Promise<number>;
}

export function createDefaultSessionStore(appName = 'cortx'): SessionStore {
  return createStorageSessionStore(getStorage(appName).state.namespace('sessions'));
}

export function createStorageSessionStore(dir: StorageDir): SessionStore {
  return new StorageSessionStore(dir);
}

class StorageSessionStore implements SessionStore {
  readonly path: string;

  constructor(private readonly dir: StorageDir) {
    this.path = dir.path;
  }

  async listFiles(): Promise<string[]> {
    try {
      await mkdir(this.path, { recursive: true });
      const files = await readdir(this.path);
      return files
        .filter((file) => sessionIdFromFilename(file) !== null)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  async read(sessionId: string): Promise<SessionMetadata | null> {
    try {
      return (await this.dir.readJSON<SessionMetadata>(sessionFilename(sessionId))) ?? null;
    } catch {
      return null;
    }
  }

  async write(metadata: SessionMetadata): Promise<void> {
    await this.dir.writeJSON(sessionFilename(metadata.sessionId), metadata);
  }

  async delete(sessionId: string): Promise<void> {
    await this.dir.delete(sessionFilename(sessionId));
  }

  async list(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const file of await this.listFiles()) {
      const sessionId = sessionIdFromFilename(file);
      if (!sessionId) continue;
      const meta = await this.read(sessionId);
      if (meta) summaries.push(metadataToSummary(meta));
    }
    return summaries;
  }

  async findCrashed(): Promise<SessionSummary[]> {
    return (await this.list()).filter((summary) => summary.status === 'crashed');
  }

  async cleanup(maxSessions = DEFAULT_MAX_SESSIONS): Promise<number> {
    const files = await this.listFiles();
    if (files.length <= maxSessions) return 0;

    let deleted = 0;
    for (const file of files.slice(maxSessions)) {
      const sessionId = sessionIdFromFilename(file);
      if (!sessionId) continue;
      try {
        await this.delete(sessionId);
        deleted++;
      } catch {
        // Best-effort cleanup; a single stubborn file should not block saving.
      }
    }
    return deleted;
  }
}
