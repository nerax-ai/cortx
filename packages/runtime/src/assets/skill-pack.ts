import { access, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export const SKILL_PACK_MANIFEST_SCHEMA_VERSION = 1;

export interface SkillPackManifest {
  schemaVersion?: typeof SKILL_PACK_MANIFEST_SCHEMA_VERSION;
  name?: string;
  version?: string;
  description?: string;
  skillPaths?: string[];
  agentSpecPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface SkillPack {
  schemaVersion: typeof SKILL_PACK_MANIFEST_SCHEMA_VERSION;
  name?: string;
  version?: string;
  description?: string;
  path: string;
  manifestPath?: string;
  skillPaths: string[];
  agentSpecPaths: string[];
  metadata?: Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function parseSkillPackManifest(value: unknown): SkillPackManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SkillPack manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== SKILL_PACK_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`SkillPack.schemaVersion must be ${SKILL_PACK_MANIFEST_SCHEMA_VERSION}`);
  }
  assertOptionalString(manifest, 'name');
  assertOptionalString(manifest, 'version');
  assertOptionalString(manifest, 'description');
  assertOptionalStringArray(manifest, 'skillPaths');
  assertOptionalStringArray(manifest, 'agentSpecPaths');
  assertOptionalMetadata(manifest);
  return {
    ...manifest,
    schemaVersion: manifest.schemaVersion ?? SKILL_PACK_MANIFEST_SCHEMA_VERSION,
  } as SkillPackManifest;
}

export async function resolveSkillPack(path: string): Promise<SkillPack> {
  const root = resolve(path);
  const manifestPath = await findManifestPath(root);
  const manifest = manifestPath
    ? parseSkillPackManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
    : undefined;
  const defaults = await resolveDefaultAssetPaths(root);
  const skillPaths =
    manifest?.skillPaths === undefined
      ? defaults.skillPaths
      : await resolveManifestAssetPaths(root, manifest.skillPaths, 'skillPaths');
  const agentSpecPaths =
    manifest?.agentSpecPaths === undefined
      ? defaults.agentSpecPaths
      : await resolveManifestAssetPaths(root, manifest.agentSpecPaths, 'agentSpecPaths');

  return {
    schemaVersion: SKILL_PACK_MANIFEST_SCHEMA_VERSION,
    path: root,
    manifestPath,
    name: manifest?.name ?? basename(root),
    version: manifest?.version,
    description: manifest?.description,
    skillPaths,
    agentSpecPaths,
    metadata: manifest?.metadata,
  };
}

async function resolveDefaultAssetPaths(root: string): Promise<Pick<SkillPack, 'skillPaths' | 'agentSpecPaths'>> {
  const skillPaths: string[] = [];
  const agentSpecPaths: string[] = [];
  const skillsDir = join(root, 'skills');
  const cortxSkillsDir = join(root, '.cortx', 'skills');
  const agentsDir = join(root, 'agents');

  if (await exists(skillsDir)) skillPaths.push(skillsDir);
  if (await exists(cortxSkillsDir)) skillPaths.push(cortxSkillsDir);
  if (await exists(agentsDir)) agentSpecPaths.push(agentsDir);

  return { skillPaths, agentSpecPaths };
}

async function findManifestPath(root: string): Promise<string | undefined> {
  const visible = join(root, 'skill-pack.json');
  if (await exists(visible)) return visible;
  const hidden = join(root, '.cortx', 'skill-pack.json');
  if (await exists(hidden)) return hidden;
  return undefined;
}

async function resolveManifestAssetPaths(root: string, paths: string[], key: string): Promise<string[]> {
  const resolved: string[] = [];
  for (const path of paths) {
    if (!path.trim()) {
      throw new Error(`SkillPack.${key} entries must be non-empty relative paths`);
    }
    if (isAbsolute(path)) {
      throw new Error(`SkillPack.${key} entries must be relative paths`);
    }
    const candidate = resolve(root, path);
    const relativePath = relative(root, candidate);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`SkillPack.${key} entries must stay inside the pack root`);
    }
    if (!(await exists(candidate))) {
      throw new Error(`SkillPack.${key} path does not exist: ${path}`);
    }
    resolved.push(candidate);
  }
  return resolved;
}

function assertOptionalString(manifest: Record<string, unknown>, key: string): void {
  if (manifest[key] !== undefined && typeof manifest[key] !== 'string') {
    throw new Error(`SkillPack.${key} must be a string`);
  }
}

function assertOptionalStringArray(manifest: Record<string, unknown>, key: string): void {
  if (manifest[key] === undefined) return;
  if (!Array.isArray(manifest[key]) || !(manifest[key] as unknown[]).every((item) => typeof item === 'string')) {
    throw new Error(`SkillPack.${key} must be an array of strings`);
  }
}

function assertOptionalMetadata(manifest: Record<string, unknown>): void {
  if (manifest.metadata === undefined) return;
  if (typeof manifest.metadata !== 'object' || manifest.metadata === null || Array.isArray(manifest.metadata)) {
    throw new Error('SkillPack.metadata must be an object');
  }
}
