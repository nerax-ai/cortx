import type { Tool } from '@cortx/sdk';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { RuntimeDefaultCapabilities } from '../default-capabilities.js';
import type { RuntimeApprovalMode } from '../session.js';
import type { WorkspaceToolMode } from '../tool-mount.js';
import { resolveSkillPack } from './skill-pack.js';

export interface AgentSpec {
  name?: string;
  prompt: string;
  system?: string;
  model?: string;
  workingDirectory?: string;
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  capabilities?: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  tools?: Tool[];
  metadata?: Record<string, unknown>;
}

export interface DiscoveredAgentSpec {
  path: string;
  relativePath: string;
  sourceRoot: string;
  name: string;
  promptPreview: string;
  workingDirectory?: string;
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  skillPacks?: string[];
  metadata?: Record<string, unknown>;
}

export interface DiscoverAgentSpecsOptions {
  roots?: string[];
  skillPacks?: string[];
  strict?: boolean;
  maxDepth?: number;
}

export function parseAgentSpec(value: unknown): AgentSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('AgentSpec must be an object');
  }
  const spec = value as Record<string, unknown>;
  if (typeof spec.prompt !== 'string' || !spec.prompt.trim()) {
    throw new Error('AgentSpec.prompt must be a non-empty string');
  }
  assertOptionalString(spec, 'name');
  assertOptionalString(spec, 'system');
  assertOptionalString(spec, 'model');
  assertOptionalString(spec, 'workingDirectory');
  assertOptionalEnum(spec, 'toolMode', ['none', 'read-only', 'coding', 'all']);
  assertOptionalEnum(spec, 'approvalMode', ['deny', 'interactive', 'full-access']);
  assertOptionalStringArray(spec, 'skillPaths');
  assertOptionalStringArray(spec, 'skillPacks');
  assertOptionalCapabilities(spec);
  return spec as unknown as AgentSpec;
}

export async function loadAgentSpecFile(path: string): Promise<AgentSpec> {
  const value = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  return parseAgentSpec(value);
}

export async function discoverAgentSpecs(options: DiscoverAgentSpecsOptions = {}): Promise<DiscoveredAgentSpec[]> {
  const maxDepth = options.maxDepth ?? 8;
  const roots = new Map<string, string>();
  for (const root of options.roots ?? []) {
    roots.set(resolve(root), resolve(root));
  }
  for (const packPath of options.skillPacks ?? []) {
    const pack = await resolveSkillPack(packPath);
    for (const agentSpecPath of pack.agentSpecPaths) {
      roots.set(resolve(agentSpecPath), resolve(pack.path));
    }
  }

  const candidates = new Map<string, string>();
  for (const [root, sourceRoot] of roots) {
    for (const candidate of await findAgentSpecFiles(root, maxDepth)) {
      candidates.set(candidate, sourceRoot);
    }
  }

  const specs: DiscoveredAgentSpec[] = [];
  for (const [path, sourceRoot] of [...candidates.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    try {
      const spec = await loadAgentSpecFile(path);
      specs.push({
        path,
        relativePath: relative(sourceRoot, path) || basename(path),
        sourceRoot,
        name: spec.name?.trim() || basename(path, extname(path)),
        promptPreview: previewPrompt(spec.prompt),
        workingDirectory: spec.workingDirectory,
        toolMode: spec.toolMode,
        approvalMode: spec.approvalMode,
        skillPacks: spec.skillPacks,
        metadata: spec.metadata,
      });
    } catch (error) {
      if (options.strict) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid AgentSpec at ${path}: ${message}`);
      }
    }
  }
  return specs;
}

async function findAgentSpecFiles(root: string, maxDepth: number): Promise<string[]> {
  const resolved = resolve(root);
  const info = await stat(resolved).catch(() => undefined);
  if (!info) return [];
  if (info.isFile()) return extname(resolved) === '.json' ? [resolved] : [];
  if (!info.isDirectory()) return [];
  if (basename(resolved) === 'agents') return collectJsonFiles(resolved);

  const files: string[] = [];
  await walkForAgentDirs(resolved, maxDepth, files);
  return files;
}

async function walkForAgentDirs(dir: string, depth: number, files: string[]): Promise<void> {
  if (depth < 0) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldIgnoreDirectory(entry.name)) continue;
    const child = join(dir, entry.name);
    if (entry.name === 'agents') {
      files.push(...(await collectJsonFiles(child)));
      continue;
    }
    await walkForAgentDirs(child, depth - 1, files);
  }
}

async function collectJsonFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  await walkJsonFiles(dir, files);
  return files;
}

async function walkJsonFiles(dir: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldIgnoreDirectory(entry.name)) await walkJsonFiles(child, files);
    } else if (entry.isFile() && extname(entry.name) === '.json') {
      files.push(resolve(child));
    }
  }
}

function shouldIgnoreDirectory(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build' || name === '.turbo';
}

function previewPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function assertOptionalString(spec: Record<string, unknown>, key: string): void {
  if (spec[key] !== undefined && typeof spec[key] !== 'string') {
    throw new Error(`AgentSpec.${key} must be a string`);
  }
}

function assertOptionalStringArray(spec: Record<string, unknown>, key: string): void {
  if (spec[key] === undefined) return;
  if (!Array.isArray(spec[key]) || !(spec[key] as unknown[]).every((item) => typeof item === 'string')) {
    throw new Error(`AgentSpec.${key} must be an array of strings`);
  }
}

function assertOptionalEnum(spec: Record<string, unknown>, key: string, values: string[]): void {
  if (spec[key] === undefined) return;
  if (typeof spec[key] !== 'string' || !values.includes(spec[key])) {
    throw new Error(`AgentSpec.${key} must be one of: ${values.join(', ')}`);
  }
}

function assertOptionalCapabilities(spec: Record<string, unknown>): void {
  const capabilities = spec.capabilities;
  if (capabilities === undefined) return;
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    throw new Error('AgentSpec.capabilities must be an object');
  }
  for (const [key, value] of Object.entries(capabilities)) {
    if (!['skills', 'subAgents', 'approval'].includes(key) || typeof value !== 'boolean') {
      throw new Error('AgentSpec.capabilities may only contain boolean skills, subAgents, and approval fields');
    }
  }
}
