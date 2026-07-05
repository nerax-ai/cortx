import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { resolveSkillPack, type SkillPack } from './skill-pack.js';

export const SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION = 1;

export interface InstalledSkillPackRecord {
  schemaVersion: typeof SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION;
  id: string;
  name: string;
  version?: string;
  description?: string;
  sourcePath: string;
  installedAt: number;
  metadata?: Record<string, unknown>;
}

export interface InstalledSkillPack extends SkillPack {
  id: string;
  sourcePath: string;
  installedAt: number;
}

export interface InstallSkillPackOptions {
  registryPath: string;
  sourcePath: string;
  id?: string;
  installedAt?: number;
}

export interface SkillPackReferenceOptions {
  registryPath?: string;
}

interface SkillPackInstallRegistry {
  schemaVersion: typeof SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION;
  packs: InstalledSkillPackRecord[];
}

export async function installSkillPack(options: InstallSkillPackOptions): Promise<InstalledSkillPack> {
  const pack = await resolveSkillPack(options.sourcePath);
  const registry = await readRegistry(options.registryPath);
  const id = normalizeInstallId(options.id ?? pack.name ?? pack.path);
  const record: InstalledSkillPackRecord = {
    schemaVersion: SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION,
    id,
    name: pack.name ?? id,
    version: pack.version,
    description: pack.description,
    sourcePath: pack.path,
    installedAt: options.installedAt ?? Date.now(),
    metadata: pack.metadata,
  };
  const packs = registry.packs.filter((item) => item.id !== id);
  packs.push(record);
  await writeRegistry(options.registryPath, { schemaVersion: SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION, packs });
  return hydrateInstalledSkillPack(record);
}

export async function listInstalledSkillPacks(registryPath: string): Promise<InstalledSkillPack[]> {
  const registry = await readRegistry(registryPath);
  const packs: InstalledSkillPack[] = [];
  for (const record of registry.packs) {
    packs.push(await hydrateInstalledSkillPack(record));
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

export async function resolveSkillPackReference(
  reference: string,
  options: SkillPackReferenceOptions = {},
): Promise<SkillPack> {
  if (isPathLikeReference(reference)) return resolveSkillPack(reference);
  if (options.registryPath) {
    const installed = await findInstalledSkillPack(reference, options.registryPath);
    if (installed) return installed;
    throw new Error(`SkillPack is not installed: ${reference}`);
  }
  return resolveSkillPack(reference);
}

export async function resolveSkillPackReferences(
  references: string[] | undefined,
  options: SkillPackReferenceOptions = {},
): Promise<SkillPack[]> {
  const packs: SkillPack[] = [];
  for (const reference of references ?? []) {
    packs.push(await resolveSkillPackReference(reference, options));
  }
  return packs;
}

async function findInstalledSkillPack(reference: string, registryPath: string): Promise<InstalledSkillPack | undefined> {
  const packs = await listInstalledSkillPacks(registryPath);
  return packs.find((pack) => pack.id === reference || pack.name === reference);
}

async function hydrateInstalledSkillPack(record: InstalledSkillPackRecord): Promise<InstalledSkillPack> {
  const pack = await resolveSkillPack(record.sourcePath);
  return {
    ...pack,
    id: record.id,
    sourcePath: record.sourcePath,
    installedAt: record.installedAt,
    name: pack.name ?? record.name,
    version: pack.version ?? record.version,
    description: pack.description ?? record.description,
    metadata: pack.metadata ?? record.metadata,
  };
}

async function readRegistry(path: string): Promise<SkillPackInstallRegistry> {
  if (!(await exists(path))) {
    return { schemaVersion: SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION, packs: [] };
  }
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  return parseRegistry(parsed);
}

async function writeRegistry(path: string, registry: SkillPackInstallRegistry): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  const sorted = [...registry.packs].sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(
    resolved,
    `${JSON.stringify({ schemaVersion: SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION, packs: sorted }, null, 2)}\n`,
    'utf8',
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(resolve(path));
    return true;
  } catch {
    return false;
  }
}

function parseRegistry(value: unknown): SkillPackInstallRegistry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SkillPack registry must be an object');
  }
  const registry = value as Record<string, unknown>;
  if (registry.schemaVersion !== SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`SkillPack registry schemaVersion must be ${SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(registry.packs)) {
    throw new Error('SkillPack registry packs must be an array');
  }
  return {
    schemaVersion: SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION,
    packs: registry.packs.map(parseRecord),
  };
}

function parseRecord(value: unknown): InstalledSkillPackRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SkillPack registry record must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`SkillPack registry record schemaVersion must be ${SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION}`);
  }
  const id = requiredString(record, 'id');
  const name = requiredString(record, 'name');
  const sourcePath = requiredString(record, 'sourcePath');
  if (typeof record.installedAt !== 'number') {
    throw new Error('SkillPack registry record installedAt must be a number');
  }
  return {
    schemaVersion: SKILL_PACK_INSTALL_REGISTRY_SCHEMA_VERSION,
    id,
    name,
    sourcePath,
    installedAt: record.installedAt,
    version: optionalString(record, 'version'),
    description: optionalString(record, 'description'),
    metadata: optionalMetadata(record),
  };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== 'string' || !record[key].trim()) {
    throw new Error(`SkillPack registry record ${key} must be a non-empty string`);
  }
  return record[key];
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (record[key] === undefined) return undefined;
  if (typeof record[key] !== 'string') throw new Error(`SkillPack registry record ${key} must be a string`);
  return record[key];
}

function optionalMetadata(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (record.metadata === undefined) return undefined;
  if (typeof record.metadata !== 'object' || record.metadata === null || Array.isArray(record.metadata)) {
    throw new Error('SkillPack registry record metadata must be an object');
  }
  return record.metadata as Record<string, unknown>;
}

function normalizeInstallId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('SkillPack install id must contain letters or numbers');
  return normalized;
}

function isPathLikeReference(reference: string): boolean {
  return isAbsolute(reference) || reference.startsWith('.') || reference.includes('/') || reference.includes('\\');
}
