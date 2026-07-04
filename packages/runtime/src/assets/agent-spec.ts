import type { Tool } from '@cortx/sdk';
import type { RuntimeDefaultCapabilities } from '../default-capabilities.js';
import type { WorkspaceToolMode } from '../tool-mount.js';

export interface AgentSpec {
  name?: string;
  prompt: string;
  system?: string;
  model?: string;
  workingDirectory?: string;
  toolMode?: WorkspaceToolMode;
  approvalMode?: 'deny' | 'interactive';
  capabilities?: RuntimeDefaultCapabilities;
  skillPaths?: string[];
  skillPacks?: string[];
  tools?: Tool[];
  metadata?: Record<string, unknown>;
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
  assertOptionalEnum(spec, 'approvalMode', ['deny', 'interactive']);
  assertOptionalStringArray(spec, 'skillPaths');
  assertOptionalStringArray(spec, 'skillPacks');
  assertOptionalCapabilities(spec);
  return spec as unknown as AgentSpec;
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
