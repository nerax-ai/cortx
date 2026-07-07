import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { noopLogger, type AgentEvent, type RuntimeAgentEventEnvelope, type SkillInfo } from '@cortx/sdk';
import {
  buildFileEditDetails,
  CortxRuntime,
  discoverAgentSpecs,
  installSkillPack,
  isRuntimeError,
  listInstalledSkillPacks,
  loadAgentSpecFile,
  parseAgentSpec,
  resolveWorkspace,
  RuntimeError,
  type AgentSpec,
  type DiscoveredAgentSpec,
  type InstalledSkillPack,
  type RuntimeApprovalMode,
  type RuntimeSessionCreateRequest,
  type RuntimeSessionInfo,
  type RuntimeSessionUpdateRequest,
  type WorkspaceToolMode,
} from '@cortx/runtime';
import type { ServerConfig } from './types.js';
import { createAuthHandlers, getAuthPrincipal, type AuthPrincipal } from './auth.js';

export interface ServerRuntimeHandle {
  app: Hono;
  runtime: CortxRuntime;
  dispose(): void;
}

interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
}

interface WorkspaceDirectoryListing {
  roots: string[];
  current: string;
  parent?: string;
  entries: WorkspaceDirectoryEntry[];
}

interface WebSkillInfo {
  name: string;
  description: string;
  arguments?: string[];
  dirPath: string;
}

interface WebReasoningEffortOption {
  value: string;
  label: string;
}

interface WebModelInfo {
  id: string;
  name: string;
  contextWindowTokens?: number;
  reasoningEfforts?: WebReasoningEffortOption[];
}

const REASONING_EFFORT_LABELS: Record<string, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Light',
  light: 'Light',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  'extra-high': 'Extra High',
};

const DEFAULT_REASONING_EFFORTS: WebReasoningEffortOption[] = [
  { value: 'low', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

function serializeEvent(event: AgentEvent): string {
  if (event.type === 'error' && event.error instanceof Error) {
    return JSON.stringify({ ...event, error: { message: event.error.message, name: event.error.name } });
  }
  return JSON.stringify(event);
}

function serializeEnvelope(envelope: RuntimeAgentEventEnvelope): string {
  if (envelope.event.type === 'error' && envelope.event.error instanceof Error) {
    return JSON.stringify({
      ...envelope,
      event: {
        ...envelope.event,
        error: { message: envelope.event.error.message, name: envelope.event.error.name },
      },
    });
  }
  return JSON.stringify(envelope);
}

function serializeEventData(event: AgentEvent): AgentEvent {
  return JSON.parse(serializeEvent(event)) as AgentEvent;
}

function serializeEnvelopeData(envelope: RuntimeAgentEventEnvelope): RuntimeAgentEventEnvelope {
  return JSON.parse(serializeEnvelope(envelope)) as RuntimeAgentEventEnvelope;
}

function serializeSkillInfo(skill: SkillInfo): WebSkillInfo {
  return {
    name: skill.name,
    description: skill.description,
    arguments: skill.arguments,
    dirPath: skill.dirPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseToolInput(input: unknown): Record<string, unknown> | undefined {
  if (isRecord(input)) return input;
  if (typeof input !== 'string') return undefined;
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().split(/[.:/]/).pop() ?? toolName.toLowerCase();
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

async function hydrateHistoricalFileEditDetails(
  envelopes: RuntimeAgentEventEnvelope[],
  workingDirectory: string,
): Promise<RuntimeAgentEventEnvelope[]> {
  const toolInputs = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  const fileSnapshots = new Map<string, string>();
  let result = envelopes;

  function replaceEvent(index: number, event: AgentEvent): void {
    if (result === envelopes) result = [...envelopes];
    result[index] = { ...envelopes[index], event };
  }

  envelopes.forEach((envelope, index) => {
    const event = envelope.event;
    if (event.type === 'tool_use') {
      const input = parseToolInput(event.toolCall.input);
      if (input) {
        toolInputs.set(event.toolCall.toolCallId, {
          toolName: normalizedToolName(event.toolCall.toolName),
          input,
        });
      }
      return;
    }

    if (event.type !== 'tool_result' || event.isError) return;
    const toolUse = toolInputs.get(event.toolCallId);
    if (!toolUse) return;

    if (toolUse.toolName === 'write') {
      const path = stringField(toolUse.input, 'path');
      const content = stringField(toolUse.input, 'content');
      if (path && content !== undefined) fileSnapshots.set(path, content);
      return;
    }

    if (toolUse.toolName !== 'edit') return;
    const path = stringField(toolUse.input, 'path');
    const oldText = stringField(toolUse.input, 'oldText');
    const newText = stringField(toolUse.input, 'newText');
    if (!path || oldText === undefined || newText === undefined) return;

    const before = fileSnapshots.get(path);
    if (before === undefined || !before.includes(oldText)) return;
    const after = before.replace(oldText, newText);
    fileSnapshots.set(path, after);

    if (event.details !== undefined) return;
    replaceEvent(index, {
      ...event,
      details: buildFileEditDetails(path, before, after),
    });
  });

  const reverseFileStates = new Map<string, string | undefined>();
  const attemptedFileLoads = new Set<string>();

  async function loadCurrentFile(path: string): Promise<string | undefined> {
    if (attemptedFileLoads.has(path)) return reverseFileStates.get(path);
    attemptedFileLoads.add(path);
    try {
      const workspace = await resolveWorkspace({
        requested: path,
        defaultWorkingDirectory: workingDirectory,
        allowedRoots: [workingDirectory],
      });
      const content = await readFile(workspace.workingDirectory, 'utf8');
      reverseFileStates.set(path, content);
      return content;
    } catch {
      reverseFileStates.set(path, undefined);
      return undefined;
    }
  }

  function replaceUnique(content: string, oldText: string, newText: string): string | undefined {
    const first = content.indexOf(oldText);
    if (first === -1 || first !== content.lastIndexOf(oldText)) return undefined;
    return `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
  }

  for (let index = result.length - 1; index >= 0; index--) {
    const envelope = result[index]!;
    const event = envelope.event;
    if (event.type !== 'tool_result' || event.isError) continue;
    const toolUse = toolInputs.get(event.toolCallId);
    if (!toolUse) continue;

    if (toolUse.toolName === 'write') {
      const path = stringField(toolUse.input, 'path');
      if (path) reverseFileStates.set(path, undefined);
      continue;
    }

    if (toolUse.toolName !== 'edit') continue;
    const path = stringField(toolUse.input, 'path');
    const oldText = stringField(toolUse.input, 'oldText');
    const newText = stringField(toolUse.input, 'newText');
    if (!path || oldText === undefined || newText === undefined) continue;

    const after = reverseFileStates.has(path) ? reverseFileStates.get(path) : await loadCurrentFile(path);
    if (after === undefined) continue;
    const before = replaceUnique(after, newText, oldText);
    if (before === undefined) continue;
    reverseFileStates.set(path, before);

    if (event.details !== undefined) continue;
    replaceEvent(index, {
      ...event,
      details: buildFileEditDetails(path, before, after),
    });
  }

  return result;
}

function readModelContextWindow(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const limits = value.limits;
  if (isRecord(limits)) {
    const context = readPositiveInteger(limits.context);
    if (context !== undefined) return context;
  }
  const nestedModel = value.model;
  if (isRecord(nestedModel)) {
    const context = readModelContextWindow(nestedModel);
    if (context !== undefined) return context;
  }
  const metadata = value.metadata;
  if (isRecord(metadata)) {
    const context = readModelContextWindow({ limits: metadata.limits });
    if (context !== undefined) return context;
  }
  return undefined;
}

function normalizeReasoningEffortOption(value: unknown): WebReasoningEffortOption | undefined {
  if (typeof value === 'string' && value.trim()) {
    const effort = value.trim();
    return { value: effort, label: REASONING_EFFORT_LABELS[effort] ?? effort };
  }
  if (!isRecord(value)) return undefined;
  const rawValue = value.value ?? value.id ?? value.effort ?? value.name;
  if (typeof rawValue !== 'string' || !rawValue.trim()) return undefined;
  const effort = rawValue.trim();
  const rawLabel = value.label ?? value.name ?? value.title;
  return {
    value: effort,
    label: typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : REASONING_EFFORT_LABELS[effort] ?? effort,
  };
}

function normalizeReasoningEffortOptions(value: unknown): WebReasoningEffortOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map(normalizeReasoningEffortOption)
    .filter((option): option is WebReasoningEffortOption => option !== undefined);
  const seen = new Set<string>();
  const deduped = options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
  return deduped.length ? deduped : undefined;
}

function readReasoningEffortOptionsFromRecord(record: Record<string, unknown>): WebReasoningEffortOption[] | undefined {
  const direct =
    normalizeReasoningEffortOptions(record.reasoningEfforts) ??
    normalizeReasoningEffortOptions(record.reasoningEffortOptions) ??
    normalizeReasoningEffortOptions(record.thinkingEfforts) ??
    normalizeReasoningEffortOptions(record.thinkingEffortOptions);
  if (direct) return direct;

  for (const key of ['reasoning', 'thinking']) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const nestedOptions =
      normalizeReasoningEffortOptions(nested.efforts) ??
      normalizeReasoningEffortOptions(nested.options) ??
      normalizeReasoningEffortOptions(nested.levels);
    if (nestedOptions) return nestedOptions;
  }

  for (const key of ['metadata', 'options', 'model']) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const nestedOptions = readReasoningEffortOptionsFromRecord(nested);
    if (nestedOptions) return nestedOptions;
  }

  return undefined;
}

function modelSupportsReasoning(record: Record<string, unknown>): boolean {
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  if (capabilities?.reasoning === true) return true;
  const model = isRecord(record.model) ? record.model : undefined;
  const modelCapabilities = model && isRecord(model.capabilities) ? model.capabilities : undefined;
  if (modelCapabilities?.reasoning === true) return true;
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;
  if (metadata?.reasoning === true || metadata?.thinking === true) return true;
  return Boolean(readReasoningEffortOptionsFromRecord(record));
}

function serializeModelInfo(value: unknown): WebModelInfo | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : undefined;
  if (!id) return undefined;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id;
  const explicitReasoningEfforts = readReasoningEffortOptionsFromRecord(value);
  const reasoningEfforts = explicitReasoningEfforts ?? (modelSupportsReasoning(value) ? DEFAULT_REASONING_EFFORTS : undefined);
  return {
    id,
    name,
    contextWindowTokens: readModelContextWindow(value),
    reasoningEfforts,
  };
}

function mergeModelInfo(current: WebModelInfo | undefined, next: WebModelInfo): WebModelInfo {
  if (!current) return next;
  return {
    id: current.id,
    name: current.name || next.name,
    contextWindowTokens: current.contextWindowTokens ?? next.contextWindowTokens,
    reasoningEfforts: current.reasoningEfforts ?? next.reasoningEfforts,
  };
}

function listServerModels(config: ServerConfig): WebModelInfo[] {
  const byId = new Map<string, WebModelInfo>();
  const candidates = [...(config.modelCatalog ?? []), ...(config.models ?? [])];
  for (const candidate of candidates) {
    const info = serializeModelInfo(candidate);
    if (!info) continue;
    byId.set(info.id, mergeModelInfo(byId.get(info.id), info));
  }
  if (!byId.has(config.model)) {
    byId.set(config.model, {
      id: config.model,
      name: config.model,
      contextWindowTokens: config.contextWindowTokens,
    });
  }
  return [...byId.values()];
}

function parseOptionalSequence(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RuntimeError('invalid_request', `${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RuntimeError('invalid_request', 'limit must be a positive integer');
  }
  return Math.min(parsed, 2_000);
}

function errorResponse(error: unknown): {
  body: { error: string; kind?: string; details?: Record<string, unknown> };
  status: ContentfulStatusCode;
} {
  if (isRuntimeError(error)) {
    return {
      body: { error: error.message, kind: error.kind, details: error.details },
      status: error.status as ContentfulStatusCode,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { body: { error: message }, status: 500 as ContentfulStatusCode };
}

async function readOptionalJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    throw new RuntimeError('invalid_request', 'JSON body must be an object');
  } catch (error) {
    if (isRuntimeError(error)) throw error;
    throw new RuntimeError('invalid_request', 'Invalid JSON body');
  }
}

function readMessage(body: Record<string, unknown>): string {
  if (body.message === undefined) return '';
  if (typeof body.message !== 'string') throw new RuntimeError('invalid_request', 'message must be a string');
  return body.message;
}

function getDefaultWorkingDirectory(config: ServerConfig): string {
  return config.defaultWorkingDirectory ?? process.cwd();
}

function getServerAllowedWorkspaceRoots(config: ServerConfig): string[] {
  const defaultWorkingDirectory = getDefaultWorkingDirectory(config);
  return config.allowedWorkspaceRoots?.length ? config.allowedWorkspaceRoots : [defaultWorkingDirectory];
}

function getRuntimeAllowedWorkspaceRoots(config: ServerConfig): string[] {
  return [
    ...new Set([
      ...getServerAllowedWorkspaceRoots(config),
      ...(config.apiKeys ?? []).flatMap((entry) => entry.allowedWorkspaceRoots ?? []),
    ]),
  ];
}

function getSkillPackRegistryPath(config: ServerConfig): string {
  return config.skillPackRegistryPath ?? resolve(getDefaultWorkingDirectory(config), '.cortx', 'skill-packs', 'registry.json');
}

function getPrincipalAllowedWorkspaceRoots(config: ServerConfig, principal: AuthPrincipal | undefined): string[] {
  return principal?.allowedWorkspaceRoots?.length ? principal.allowedWorkspaceRoots : getServerAllowedWorkspaceRoots(config);
}

function getAgentSpecDiscoveryRoots(config: ServerConfig, principal: AuthPrincipal | undefined): string[] {
  if (config.agentSpecRoots?.length) return config.agentSpecRoots.map((root) => resolve(root));
  if (principal?.allowedWorkspaceRoots?.length) return principal.allowedWorkspaceRoots.map((root) => resolve(root));
  return [resolve(getDefaultWorkingDirectory(config))];
}

function isPathLikeReference(reference: string): boolean {
  return isAbsolute(reference) || reference.startsWith('.') || reference.includes('/') || reference.includes('\\');
}

function resolveSourceRootReference(sourceRoot: string, reference: string): string {
  return isAbsolute(reference) ? resolve(reference) : resolve(sourceRoot, reference);
}

async function authorizeWorkspace(
  config: ServerConfig,
  principal: AuthPrincipal | undefined,
  requested?: string,
): ReturnType<typeof resolveWorkspace> {
  try {
    return await resolveWorkspace({
      requested,
      defaultWorkingDirectory: getDefaultWorkingDirectory(config),
      allowedRoots: getPrincipalAllowedWorkspaceRoots(config, principal),
    });
  } catch (error) {
    if (principal?.allowedWorkspaceRoots?.length && isRuntimeError(error) && error.kind === 'invalid_workspace') {
      throw new RuntimeError('permission_denied', 'workspace is outside the current API key scope', {
        requested,
        principal: principal.id,
        allowedRoots: principal.allowedWorkspaceRoots,
      });
    }
    throw error;
  }
}

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RuntimeError('invalid_request', `${field} must be a string`);
  return value;
}

const TOOL_MODE_RANK: Record<WorkspaceToolMode, number> = {
  none: 0,
  'read-only': 1,
  coding: 2,
  all: 3,
};

const APPROVAL_MODE_RANK: Record<RuntimeApprovalMode, number> = {
  deny: 0,
  interactive: 1,
  'full-access': 2,
};

function assertWithinToolScope(
  requested: WorkspaceToolMode | undefined,
  allowed: WorkspaceToolMode | undefined,
  principal: AuthPrincipal,
): void {
  if (!requested || !allowed) return;
  const requestedRank = (TOOL_MODE_RANK as Record<string, number | undefined>)[requested];
  if (requestedRank === undefined) {
    throw new RuntimeError('invalid_request', 'toolMode must be one of: none, read-only, coding, all', {
      toolMode: requested,
    });
  }
  if (requestedRank <= TOOL_MODE_RANK[allowed]) return;
  throw new RuntimeError('permission_denied', 'toolMode is outside the current API key scope', {
    requested,
    allowed,
    principal: principal.id,
  });
}

function assertWithinApprovalScope(
  requested: RuntimeApprovalMode | undefined,
  allowed: RuntimeApprovalMode | undefined,
  principal: AuthPrincipal,
): void {
  if (!requested || !allowed) return;
  const requestedRank = (APPROVAL_MODE_RANK as Record<string, number | undefined>)[requested];
  if (requestedRank === undefined) {
    throw new RuntimeError('invalid_request', 'approvalMode must be one of: deny, interactive, full-access', {
      approvalMode: requested,
    });
  }
  if (requestedRank <= APPROVAL_MODE_RANK[allowed]) return;
  throw new RuntimeError('permission_denied', 'approvalMode is outside the current API key scope', {
    requested,
    allowed,
    principal: principal.id,
  });
}

function applyPrincipalSessionBounds<T extends RuntimeSessionCreateRequest | AgentSpec>(
  request: T,
  principal: AuthPrincipal | undefined,
): T {
  const next = { ...request };

  if (principal?.toolMode) {
    assertWithinToolScope(next.toolMode, principal.toolMode, principal);
    next.toolMode = next.toolMode ?? principal.toolMode;
  }

  if (principal?.approvalMode) {
    assertWithinApprovalScope(next.approvalMode, principal.approvalMode, principal);
    next.approvalMode = next.approvalMode ?? principal.approvalMode;
  }

  return next as T;
}

async function buildAuthorizedSessionRequest(
  c: Context,
  config: ServerConfig,
  body: Record<string, unknown>,
): Promise<RuntimeSessionCreateRequest> {
  const principal = getAuthPrincipal(c);
  const requested = assertOptionalString(body.workingDirectory, 'workingDirectory');
  const workspace = await authorizeWorkspace(config, principal, requested);
  return applyPrincipalSessionBounds(
    {
      ...body,
      workingDirectory: workspace.workingDirectory,
    } as RuntimeSessionCreateRequest,
    principal,
  ) as RuntimeSessionCreateRequest;
}

function buildAuthorizedSessionUpdateRequest(c: Context, body: Record<string, unknown>): RuntimeSessionUpdateRequest {
  const principal = getAuthPrincipal(c);
  const request = { ...body } as RuntimeSessionUpdateRequest;
  if (principal?.toolMode) assertWithinToolScope(request.toolMode, principal.toolMode, principal);
  if (principal?.approvalMode) assertWithinApprovalScope(request.approvalMode, principal.approvalMode, principal);
  return request;
}

async function assertSessionAccess(c: Context, config: ServerConfig, session: RuntimeSessionInfo): Promise<void> {
  await authorizeWorkspace(config, getAuthPrincipal(c), session.workingDirectory);
}

async function getAuthorizedSession(
  runtime: CortxRuntime,
  c: Context,
  config: ServerConfig,
  id: string,
): Promise<RuntimeSessionInfo> {
  let session: RuntimeSessionInfo;
  try {
    session = runtime.getSession(id);
  } catch (error) {
    if (!isRuntimeError(error) || error.kind !== 'session_not_found') throw error;
    await runtime.restoreDurableSessions({ autoResume: false });
    session = runtime.getSession(id);
  }
  await assertSessionAccess(c, config, session);
  return session;
}

async function listAuthorizedSessions(runtime: CortxRuntime, c: Context, config: ServerConfig): Promise<RuntimeSessionInfo[]> {
  await runtime.restoreDurableSessions({ autoResume: false });
  const visible: RuntimeSessionInfo[] = [];
  for (const session of runtime.listSessions()) {
    try {
      await assertSessionAccess(c, config, session);
      visible.push(session);
    } catch (error) {
      if (isRuntimeError(error) && (error.kind === 'permission_denied' || error.kind === 'invalid_workspace')) continue;
      throw error;
    }
  }
  return visible;
}

async function listAuthorizedAgentSpecs(c: Context, config: ServerConfig): Promise<DiscoveredAgentSpec[]> {
  const principal = getAuthPrincipal(c);
  const discovered = await discoverAgentSpecs({
    roots: getAgentSpecDiscoveryRoots(config, principal),
    installedSkillPackRegistryPath: getSkillPackRegistryPath(config),
    strict: false,
  });
  const visible: DiscoveredAgentSpec[] = [];
  for (const spec of discovered) {
    try {
      await authorizeWorkspace(config, principal, dirname(spec.path));
      if (spec.workingDirectory) await authorizeWorkspace(config, principal, spec.workingDirectory);
      visible.push(spec);
    } catch (error) {
      if (isRuntimeError(error) && (error.kind === 'permission_denied' || error.kind === 'invalid_workspace')) continue;
      throw error;
    }
  }
  return visible;
}

async function listAuthorizedSkillPacks(c: Context, config: ServerConfig): Promise<InstalledSkillPack[]> {
  const principal = getAuthPrincipal(c);
  const visible: InstalledSkillPack[] = [];
  for (const pack of await listInstalledSkillPacks(getSkillPackRegistryPath(config))) {
    try {
      await authorizeWorkspace(config, principal, pack.sourcePath);
      visible.push(pack);
    } catch (error) {
      if (isRuntimeError(error) && (error.kind === 'permission_denied' || error.kind === 'invalid_workspace')) continue;
      throw error;
    }
  }
  return visible;
}

async function findAuthorizedAgentSpecSourceRoot(c: Context, config: ServerConfig, specPath: string): Promise<string> {
  const resolvedSpecPath = resolve(specPath);
  for (const spec of await listAuthorizedAgentSpecs(c, config)) {
    if (resolve(spec.path) === resolvedSpecPath) return spec.sourceRoot;
  }
  return resolve(getDefaultWorkingDirectory(config));
}

async function resolveAgentSpecAssetReferences(
  spec: AgentSpec,
  config: ServerConfig,
  principal: AuthPrincipal | undefined,
  sourceRoot: string,
): Promise<AgentSpec> {
  const skillPaths = spec.skillPaths?.map((path) => resolveSourceRootReference(sourceRoot, path));
  const skillPacks = spec.skillPacks?.map((reference) =>
    isPathLikeReference(reference) ? resolveSourceRootReference(sourceRoot, reference) : reference,
  );
  for (const path of skillPaths ?? []) {
    await authorizeWorkspace(config, principal, path);
  }
  for (const reference of skillPacks ?? []) {
    if (isPathLikeReference(reference)) await authorizeWorkspace(config, principal, reference);
  }
  return {
    ...spec,
    skillPaths,
    skillPacks,
  };
}

async function tryAuthorizeDirectory(
  c: Context,
  config: ServerConfig,
  path: string,
): Promise<string | undefined> {
  try {
    const workspace = await authorizeWorkspace(config, getAuthPrincipal(c), path);
    const info = await stat(workspace.workingDirectory);
    if (!info.isDirectory()) return undefined;
    return workspace.workingDirectory;
  } catch (error) {
    if (isRuntimeError(error) && (error.kind === 'permission_denied' || error.kind === 'invalid_workspace')) {
      return undefined;
    }
    return undefined;
  }
}

async function listWorkspaceDirectories(c: Context, config: ServerConfig): Promise<WorkspaceDirectoryListing> {
  const principal = getAuthPrincipal(c);
  const roots = getPrincipalAllowedWorkspaceRoots(config, principal).map((root) => resolve(root));
  const requested = c.req.query('path');
  const workspace = await authorizeWorkspace(config, principal, requested || roots[0]);
  const current = workspace.workingDirectory;
  let currentInfo: Awaited<ReturnType<typeof stat>>;
  try {
    currentInfo = await stat(current);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError('invalid_workspace', `workspace path is not accessible: ${current}`, { cause: message });
  }
  if (!currentInfo.isDirectory()) {
    throw new RuntimeError('invalid_workspace', `workspace path is not a directory: ${current}`, { requested: current });
  }
  const parentPath = dirname(current);
  const parent = parentPath === current ? undefined : await tryAuthorizeDirectory(c, config, parentPath);
  const children = await readdir(current, { withFileTypes: true });
  const entries: WorkspaceDirectoryEntry[] = [];

  for (const child of children) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const childPath = resolve(current, child.name);
    const authorized = await tryAuthorizeDirectory(c, config, childPath);
    if (authorized) entries.push({ name: child.name, path: authorized });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { roots, current, parent, entries };
}

async function installSkillPackFromBody(c: Context, config: ServerConfig, body: Record<string, unknown>): Promise<InstalledSkillPack> {
  const sourcePath = assertOptionalString(body.path, 'path');
  if (!sourcePath?.trim()) throw new RuntimeError('invalid_request', 'path is required');
  const id = assertOptionalString(body.id, 'id');
  const resolvedPath = resolve(getDefaultWorkingDirectory(config), sourcePath);
  await authorizeWorkspace(config, getAuthPrincipal(c), resolvedPath);
  return installSkillPack({
    registryPath: getSkillPackRegistryPath(config),
    sourcePath: resolvedPath,
    id,
  });
}

async function launchAgentSpecPath(runtime: CortxRuntime, config: ServerConfig, c: Context, path: string) {
  const principal = getAuthPrincipal(c);
  const defaultWorkingDirectory = config.defaultWorkingDirectory ?? process.cwd();
  const specPath = resolve(defaultWorkingDirectory, path);
  await authorizeWorkspace(config, principal, dirname(specPath));
  return launchAgentSpecSafely(async () => {
    const sourceRoot = await findAuthorizedAgentSpecSourceRoot(c, config, specPath);
    const spec = await resolveAgentSpecAssetReferences(await loadAgentSpecFile(specPath), config, principal, sourceRoot);
    const requested = assertOptionalString(spec.workingDirectory, 'AgentSpec.workingDirectory');
    const workspace = await authorizeWorkspace(config, principal, requested);
    const authorizedSpec = applyPrincipalSessionBounds(
      { ...spec, workingDirectory: workspace.workingDirectory },
      principal,
    ) as AgentSpec;
    return runtime.launchAgentSpec(authorizedSpec);
  });
}

async function launchInlineAgentSpec(runtime: CortxRuntime, config: ServerConfig, c: Context, value: unknown) {
  const principal = getAuthPrincipal(c);
  return launchAgentSpecSafely(async () => {
    const spec = await resolveAgentSpecAssetReferences(
      parseAgentSpec(value),
      config,
      principal,
      resolve(getDefaultWorkingDirectory(config)),
    );
    const workspace = await authorizeWorkspace(config, principal, spec.workingDirectory);
    const authorizedSpec = applyPrincipalSessionBounds(
      { ...spec, workingDirectory: workspace.workingDirectory },
      principal,
    ) as AgentSpec;
    return runtime.launchAgentSpec(authorizedSpec);
  });
}

async function launchAgentSpecSafely(fn: () => Promise<Awaited<ReturnType<CortxRuntime['launchAgentSpec']>>>) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('AgentSpec.') || error.message.startsWith('AgentSpec '))) {
      throw new RuntimeError('invalid_request', error.message);
    }
    throw error;
  }
}

export function createServerRuntime(config: ServerConfig): ServerRuntimeHandle {
  const app = new Hono();
  const logger = config.logger ?? noopLogger;

  if (config.host === '0.0.0.0') {
    logger.warn('[server] Binding to 0.0.0.0 — server accessible from network. Ensure TLS is configured.');
  }
  const auth = createAuthHandlers({ apiKey: config.apiKey, apiKeys: config.apiKeys });

  const runtime = new CortxRuntime({
    appName: 'cortx',
    maxSessions: config.maxSessions,
    maxEventsPerSession: config.maxEventsPerSession,
    idleTimeoutMs: config.idleTimeoutMs,
    language: config.language,
    model: config.model,
    models: config.models,
    modelCatalog: config.modelCatalog,
    system: config.system,
    maxIterations: config.maxIterations,
    contextWindowTokens: config.contextWindowTokens,
    contextWindowSource: config.contextWindowSource,
    registry: config.registry,
    plugins: config.plugins,
    defaultWorkingDirectory: config.defaultWorkingDirectory,
    allowedWorkspaceRoots: getRuntimeAllowedWorkspaceRoots(config),
    toolMode: config.toolMode,
    approvalMode: config.approvalMode ?? 'interactive',
    durableStore: config.durableStore,
    skillPackRegistryPath: getSkillPackRegistryPath(config),
    logger,
  });

  // CORS
  app.use('*', cors({ origin: config.corsOrigin ?? '*' }));

  // Auth middleware (applies to all routes except health)
  app.use('*', auth.middleware);

  // Health check
  app.get('/health', (c) => {
    const sessions = runtime.listSessions();
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      sessions: sessions.length,
      runningSessions: sessions.filter((session) => session.isRunning).length,
      maxSessions: config.maxSessions,
    });
  });

  // Token exchange
  app.post('/auth/token', auth.tokenExchange);

  app.get('/models', (c) => {
    try {
      return c.json({ models: listServerModels(config) });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // Create session
  app.post('/sessions', async (c) => {
    try {
      const body = await readOptionalJson(c);
      const session = await runtime.createSession(await buildAuthorizedSessionRequest(c, config, body));
      return c.json({ sessionId: session.id, session }, 201);
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post('/agent-specs/launch', async (c) => {
    try {
      const body = await readOptionalJson(c);
      const specPath = body.path;
      const session =
        typeof specPath === 'string'
          ? await launchAgentSpecPath(runtime, config, c, specPath)
          : await launchInlineAgentSpec(runtime, config, c, body.spec ?? body);
      return c.json({ sessionId: session.id, session }, 201);
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get('/agent-specs', async (c) => {
    try {
      return c.json({ agentSpecs: await listAuthorizedAgentSpecs(c, config) });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get('/skill-packs', async (c) => {
    try {
      return c.json({ skillPacks: await listAuthorizedSkillPacks(c, config) });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post('/skill-packs/install', async (c) => {
    try {
      const body = await readOptionalJson(c);
      const skillPack = await installSkillPackFromBody(c, config, body);
      return c.json({ skillPack }, 201);
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get('/workspaces/directories', async (c) => {
    try {
      return c.json(await listWorkspaceDirectories(c, config));
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // List sessions
  app.get('/sessions', async (c) => {
    try {
      return c.json({ sessions: await listAuthorizedSessions(runtime, c, config) });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // Get session info
  app.get('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ session: await getAuthorizedSession(runtime, c, config, id) });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.patch('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
      const body = await readOptionalJson(c);
      const session = await runtime.updateSession(id, buildAuthorizedSessionUpdateRequest(c, body));
      return c.json({ session });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.get('/sessions/:id/skills', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
      const skills = await runtime.listSessionSkills(id);
      return c.json({ skills: skills.map(serializeSkillInfo) });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // Send prompt
  app.post('/sessions/:id/prompt', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
      const body = await readOptionalJson(c);
      await runtime.prompt(id, readMessage(body));
      return c.json({ ok: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post('/sessions/:id/steer', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
      const body = await readOptionalJson(c);
      runtime.steer(id, readMessage(body));
      return c.json({ ok: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post('/sessions/:id/follow-up', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
      const body = await readOptionalJson(c);
      runtime.followUp(id, readMessage(body));
      return c.json({ ok: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  app.post('/sessions/:id/resume', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
      await runtime.resume(id);
      return c.json({ ok: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // Abort session
  app.post('/sessions/:id/abort', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
      await runtime.abort(id);
      return c.json({ ok: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // Answer askUser question
  app.post('/sessions/:id/answer', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
      const body = await readOptionalJson(c);
      if (typeof body.toolCallId !== 'string' || typeof body.response !== 'string') {
        throw new RuntimeError('invalid_request', 'toolCallId and response are required');
      }
      const answered = runtime.answer(id, body.toolCallId, body.response);
      if (!answered) {
        throw new RuntimeError('invalid_request', 'No pending user question matches toolCallId', {
          toolCallId: body.toolCallId,
        });
      }
      return c.json({ ok: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // Bounded event history as one JSON payload. Web clients use this for fast
  // session switching, then open SSE for live updates only.
  app.get('/sessions/:id/events/history', async (c) => {
    const id = c.req.param('id');
    try {
      const session = await getAuthorizedSession(runtime, c, config, id);
      const useEnvelope = c.req.query('format') === 'envelope';
      const afterSequence = parseOptionalSequence(c.req.query('after'), 'after');
      const beforeSequence = parseOptionalSequence(c.req.query('before'), 'before');
      const limit = parseOptionalLimit(c.req.query('limit'));

      if (useEnvelope) {
        const page = await runtime.getEventEnvelopeHistoryPage(id, { afterSequence, beforeSequence, limit });
        const events = (await hydrateHistoricalFileEditDetails(page.events, session.workingDirectory)).map(serializeEnvelopeData);
        return c.json({
          events,
          page: {
            hasMoreBefore: page.hasMoreBefore,
            hasMoreAfter: page.hasMoreAfter,
            firstSequence: page.events[0]?.sequence,
            lastSequence: page.events.at(-1)?.sequence,
          },
        });
      }

      const events = runtime.getEventHistory(id).map(serializeEventData);
      return c.json({ events });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // SSE event stream
  app.get('/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    let useEnvelope = false;
    let replay = true;
    let afterSequence: number | undefined;
    try {
      await getAuthorizedSession(runtime, c, config, id);
      useEnvelope = c.req.query('format') === 'envelope';
      replay = c.req.query('replay') !== 'false';
      afterSequence = parseOptionalSequence(c.req.query('after'), 'after');
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }

    return streamSSE(c, async (stream) => {
      let unsub: (() => void) | undefined;
      stream.onAbort(() => {
        unsub?.();
      });

      try {
        if (useEnvelope) {
          const buffered: RuntimeAgentEventEnvelope[] = [];
          let live = false;
          let writeQueue = Promise.resolve();
          const writeEnvelope = (event: RuntimeAgentEventEnvelope) =>
            stream.writeSSE({ data: serializeEnvelope(event), id: String(event.sequence) });
          const enqueueEnvelope = (event: RuntimeAgentEventEnvelope) => {
            writeQueue = writeQueue.then(() => writeEnvelope(event)).catch(() => undefined);
          };

          unsub = runtime.subscribeEnvelopes(
            id,
            (event: RuntimeAgentEventEnvelope) => {
              if (live) {
                enqueueEnvelope(event);
              } else {
                buffered.push(event);
              }
            },
            { replay: false },
          );

          const snapshot = runtime.getEventEnvelopeHistory(id).filter((event) => {
            if (afterSequence !== undefined && event.sequence <= afterSequence) return false;
            return replay || afterSequence !== undefined;
          });
          let lastSequence = afterSequence ?? 0;
          for (const event of snapshot) {
            await writeEnvelope(event);
            lastSequence = Math.max(lastSequence, event.sequence);
          }

          live = true;
          for (const event of buffered) {
            if (event.sequence <= lastSequence) continue;
            await writeEnvelope(event);
            lastSequence = Math.max(lastSequence, event.sequence);
          }
          await writeQueue;
          await stream.writeSSE({ data: '{}' });
        } else {
          const buffered: AgentEvent[] = [];
          let live = false;
          let sequence = 0;
          let writeQueue = Promise.resolve();
          const writeEvent = (event: AgentEvent) => stream.writeSSE({ data: serializeEvent(event), id: String(++sequence) });
          const enqueueEvent = (event: AgentEvent) => {
            writeQueue = writeQueue.then(() => writeEvent(event)).catch(() => undefined);
          };

          unsub = runtime.subscribe(
            id,
            (event: AgentEvent) => {
              if (live) {
                enqueueEvent(event);
              } else {
                buffered.push(event);
              }
            },
            { replay: false },
          );

          const snapshot = replay ? runtime.getEventHistory(id) : [];
          for (const event of snapshot) await writeEvent(event);
          live = true;
          for (const event of buffered) {
            if (snapshot.includes(event)) continue;
            await writeEvent(event);
          }
          await writeQueue;
          await stream.writeSSE({ data: '{}' });
        }

        // Keep connection alive with periodic heartbeats
        while (true) {
          await stream.sleep(15000);
          await stream.writeSSE({ data: '{}' });
        }
      } catch {
        // Stream closed or timed out
      } finally {
        unsub?.();
      }
    });
  });

  // Delete session
  app.delete('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
      await runtime.deleteSession(id);
      return c.json({ ok: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  return {
    app,
    runtime,
    dispose() {
      runtime.dispose();
    },
  };
}

export function createServer(config: ServerConfig): Hono {
  return createServerRuntime(config).app;
}
