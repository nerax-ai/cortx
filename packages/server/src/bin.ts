import { Synax } from '@synax-ai/core';
import {
  createFilesystemPluginRegistry,
  createFilesystemPluginSecretsBackend,
  type JsonObject,
} from '@nerax-ai/plugin';
import { getStorage } from '@nerax-ai/storage';
import { createLogger } from '@nerax-ai/logger';
import type { ContextUsageSource, CortxContributionConfig } from '@cortx/sdk';
import type { GroupConfig, ProviderConfig } from '@synax-ai/sdk';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, parse, resolve } from 'node:path';
import {
  FileDurableRunStore,
  ProjectDomain,
  ProjectIdentityStore,
  createStandaloneCortxTopology,
  type RuntimeApprovalMode,
  type WorkspaceToolMode,
} from '@cortx/runtime';
import { createServerRuntime } from './server.js';
import type { ServerAuthKey } from './auth.js';
import { configuredPluginSources } from './plugin-sources.js';

interface CortxConfig {
  model: string;
  system?: string;
  maxIterations?: number;
  maxSessions?: number;
  maxEventsPerSession?: number;
  idleTimeoutMs?: number;
  contextWindowTokens?: number;
  workingDirectory?: string;
  allowedWorkspaceRoots?: string[];
  agentSpecRoots?: string[];
  apiKeys?: ServerAuthKey[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
  workspaceToolsPlugin?: string | false;
  plugins?: string[];
  contributions?: CortxContributionConfig[];
  providers?: ProviderConfig[];
  groups?: GroupConfig[];
  security?: {
    allowedOrigins?: string[];
    trustedProxy?: { addresses: string[]; forwardedProtoHeader?: string };
  };
}

export async function loadServerConfig(): Promise<CortxConfig | undefined> {
  return getStorage('cortx').config.readJSON<CortxConfig>('cortx.json');
}

const log = createLogger({
  appName: 'cortx',
  console: false,
  files: [{ filename: 'server-%DATE%.log', level: 'debug' }],
});

function findProjectRoot(start: string): string {
  let current = resolve(start);
  let packageFallback: string | undefined;
  while (true) {
    if (existsSync(resolve(current, '.git'))) return current;
    if (!packageFallback && existsSync(resolve(current, 'package.json'))) packageFallback = current;
    const parent = dirname(current);
    if (parent === current) return packageFallback ?? resolve(start);
    current = parent;
  }
}

function readEnvPathList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean);
}

function readPositiveEnvNumber(name: string): number | undefined {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function modelContextWindowFromSynax(synax: Synax, model: string): number | undefined {
  const context = synax.listModels().find((entry) => entry.id === model || entry.name === model)?.limits?.context;
  return typeof context === 'number' && Number.isFinite(context) && context > 0 ? Math.floor(context) : undefined;
}

function resolveContextWindow(config: CortxConfig, synax: Synax): { tokens?: number; source?: ContextUsageSource } {
  const configured = readPositiveEnvNumber('CORTX_CONTEXT_WINDOW_TOKENS') ?? config.contextWindowTokens;
  if (configured !== undefined) return { tokens: configured, source: 'configured' };
  const modelContext = modelContextWindowFromSynax(synax, config.model);
  return modelContext === undefined ? {} : { tokens: modelContext, source: 'model_metadata' };
}

function defaultAgentSpecRoots(defaultWorkingDirectory: string): string[] {
  return [
    resolve(homedir(), '.cortx', 'agents'),
    resolve(homedir(), '.cortx', 'agent-specs'),
    resolve(defaultWorkingDirectory, '.cortx', 'agents'),
    resolve(defaultWorkingDirectory, '.cortx', 'agent-specs'),
  ];
}

function defaultWorkspaceToolsPluginSource(projectRoot: string): string | undefined {
  const candidate = resolve(projectRoot, '..', 'cortx-plugins', 'workspace-tools');
  return existsSync(resolve(candidate, 'manifest.json')) ? `file:${candidate}` : undefined;
}

async function submitPluginSource(projectDomain: ProjectDomain, source: string): Promise<void> {
  try {
    const mutation = await projectDomain.registry.install(source, { enabled: true });
    if (!mutation.accepted) {
      log.warn(`[server] Plugin desired revision conflict while submitting ${source}`);
      return;
    }
    const result = await mutation.operation.wait();
    if (result.status !== 'succeeded') {
      log.warn(`[server] Plugin ${source} is ${result.status}; administration remains available for recovery`);
    }
  } catch (error) {
    log.warn(`[server] Plugin ${source} could not be submitted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const config = await loadServerConfig();
  if (!config) throw new Error('No Cortx config found');

  const sourceProjectRoot = findProjectRoot(import.meta.dir);
  const projectRoot = findProjectRoot(resolve(config.workingDirectory ?? sourceProjectRoot));
  const identityStore = new ProjectIdentityStore({ projectRoot });
  const identity = identityStore.resolve({ mode: identityStore.read() ? 'retain' : 'create' });
  const registry = createFilesystemPluginRegistry({
    appName: 'cortx',
    runtimeDomainId: identity.runtimeDomainId,
    secretsBackend: createFilesystemPluginSecretsBackend({
      appName: 'cortx',
      runtimeDomainId: identity.runtimeDomainId,
    }),
    logger: log.scope('plugins'),
  });
  const projectDomain = new ProjectDomain({
    registry,
    runtimeDomainId: identity.runtimeDomainId,
    logger: log.scope('project-domain'),
  });
  await projectDomain.start();
  for (const source of configuredPluginSources(config, {
    environmentWorkspaceToolsPlugin: process.env.CORTX_WORKSPACE_TOOLS_PLUGIN,
    defaultWorkspaceToolsPlugin: defaultWorkspaceToolsPluginSource(sourceProjectRoot),
  })) await submitPluginSource(projectDomain, source);

  const synax = new Synax({
    registry: projectDomain.registry,
    providers: [],
    groups: config.groups ?? [],
    logger: log.scope('synax'),
  });
  for (const provider of config.providers ?? []) {
    try {
      await synax.addProvider({ ...provider, options: provider.options as JsonObject | undefined });
    } catch (error) {
      log.warn(`[server] Provider ${provider.id} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const defaultWorkingDirectory = projectRoot;
  const configuredRoots = [...readEnvPathList('CORTX_WORKSPACE_ROOTS'), ...(config.allowedWorkspaceRoots ?? [])];
  const browseRoots = configuredRoots.length ? configuredRoots : [parse(defaultWorkingDirectory).root];
  const allowedWorkspaceRoots = [...new Set([...browseRoots, defaultWorkingDirectory].map((path) => resolve(path)))];
  const configuredAgentSpecRoots = [...readEnvPathList('CORTX_AGENT_SPEC_ROOTS'), ...(config.agentSpecRoots ?? [])];
  const agentSpecRoots = [...new Set(
    (configuredAgentSpecRoots.length ? configuredAgentSpecRoots : defaultAgentSpecRoots(defaultWorkingDirectory)).map((path) => resolve(path)),
  )];
  const contextWindow = resolveContextWindow(config, synax);
  const maxSessions = readPositiveEnvNumber('CORTX_MAX_RUNNING_SESSIONS') ?? config.maxSessions ?? 10;
  const maxEventsPerSession = readPositiveEnvNumber('CORTX_MAX_EVENTS_PER_SESSION') ?? config.maxEventsPerSession;
  const idleTimeoutMs = readPositiveEnvNumber('CORTX_IDLE_TIMEOUT_MS') ?? config.idleTimeoutMs ?? 30 * 60 * 1000;
  const apiKey = process.env.CORTX_API_KEY || 'cortx-dev-key';
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || 3000;

  const handle = createServerRuntime({
    apiKey,
    apiKeys: config.apiKeys,
    host,
    security: config.security,
    projectDomain,
    contributions: config.contributions,
    language: synax.language,
    model: config.model,
    models: synax.listModels(),
    modelCatalog: synax.listModelCatalog(),
    system: config.system,
    maxIterations: config.maxIterations,
    contextWindowTokens: contextWindow.tokens,
    contextWindowSource: contextWindow.source,
    defaultWorkingDirectory,
    allowedWorkspaceRoots,
    agentSpecRoots,
    toolMode: config.toolMode ?? 'none',
    approvalMode: config.approvalMode ?? 'interactive',
    durableStore: new FileDurableRunStore(process.env.CORTX_DURABLE_DIR || resolve(projectRoot, '.cortx', 'runtime')),
    logger: log.scope('server'),
    maxSessions,
    maxEventsPerSession,
    idleTimeoutMs,
  });
  try {
    await handle.runtime.restoreDurableSessions({ autoResume: false });

    const server = Bun.serve({
      hostname: host,
      port,
      idleTimeout: 255,
      fetch(request, server) {
        return handle.app.fetch(request, { remoteAddress: server.requestIP(request)?.address ?? null });
      },
    });
    const topology = createStandaloneCortxTopology({
      projectDomain,
      synax,
      runtime: handle,
      logger: { close: async () => void (await log.close()) },
    });

    console.log(`Cortx Server: http://${host}:${port}`);
    console.log(`Model: ${config.model}`);
    console.log(`Workspace: ${defaultWorkingDirectory}`);
    console.log(`Runtime domain: ${identity.runtimeDomainId}`);

    await new Promise<void>((resolveShutdown) => {
      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        server.stop();
        await topology.close();
        resolveShutdown();
      };
      process.on('SIGINT', close);
      process.on('SIGTERM', close);
    });
  } catch (error) {
    await handle.close().catch((closeError) => {
      log.error(closeError);
    });
    throw error;
  }
}

main().catch(async (error) => {
  log.error(error);
  await log.close();
  console.error(error);
  process.exit(1);
});
