import { render } from 'ink';
import { createLogger } from '@nerax-ai/logger';
import {
  createFilesystemPluginRegistry,
  createFilesystemPluginSecretsBackend,
} from '@nerax-ai/plugin';
import {
  CortxRuntime,
  ProjectDomain,
  ProjectIdentityStore,
  createRemoteCortxTopology,
  createStandaloneCortxTopology,
  type AsyncCloseable,
} from '@cortx/runtime';
import { join } from 'node:path';
import { ensureConfig, type CortxConfig } from './config.js';
import { createLanguageHost } from './language.js';
import { RemoteRuntimeClient } from './remote-client.js';
import { createLocalRuntimeSession, createRemoteRuntimeSession, type TuiRuntimeMode } from './runtime-session.js';
import { createTuiHost } from './tui-host.js';
import App from './app.js';

const log = createLogger({
  appName: 'cortx',
  console: false,
  files: [{ filename: 'cortx-%DATE%.log', level: 'debug' }],
});

function runtimeMode(config: CortxConfig): TuiRuntimeMode {
  const value = process.env.CORTX_TUI_MODE ?? process.env.CORTX_MODE ?? config.runtime?.mode ?? 'local';
  if (value === 'local' || value === 'remote') return value;
  throw new Error(`Unsupported CORTX_TUI_MODE: ${value}`);
}

function remoteOption(config: CortxConfig, key: 'baseUrl' | 'apiKey' | 'sessionId' | 'workingDirectory'): string | undefined {
  const environment: Record<typeof key, string | undefined> = {
    baseUrl: process.env.CORTX_SERVER_URL,
    apiKey: process.env.CORTX_API_KEY,
    sessionId: process.env.CORTX_SESSION_ID,
    workingDirectory: process.env.CORTX_WORKING_DIRECTORY,
  };
  return environment[key] ?? config.runtime?.server?.[key];
}

async function createRemoteComposition(config: CortxConfig, cwd: string) {
  const baseUrl = remoteOption(config, 'baseUrl') ?? 'http://127.0.0.1:3000';
  const apiKey = remoteOption(config, 'apiKey');
  if (!apiKey) throw new Error('Remote TUI requires CORTX_API_KEY or runtime.server.apiKey');
  const client = new RemoteRuntimeClient({ baseUrl, apiKey });
  try {
    const session = await createRemoteRuntimeSession({
      client,
      sessionId: remoteOption(config, 'sessionId'),
      create: {
        workingDirectory: remoteOption(config, 'workingDirectory') ?? cwd,
        model: config.model,
        system: config.system,
        maxIterations: config.maxIterations,
        contributions: config.contributions,
      },
    });
    return { session, topology: createRemoteCortxTopology({ runtimeClient: client }) };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function createLocalComposition(config: CortxConfig, cwd: string) {
  const identity = new ProjectIdentityStore({ projectRoot: cwd });
  const runtimeDomainId = identity.resolve({ mode: identity.read() ? 'retain' : 'create' }).runtimeDomainId;
  const registry = createFilesystemPluginRegistry({
    appName: 'cortx',
    runtimeDomainId,
    secretsBackend: createFilesystemPluginSecretsBackend({ appName: 'cortx', runtimeDomainId }),
    logger: log.scope('plugins'),
  });
  const projectDomain = new ProjectDomain({
    registry,
    runtimeDomainId,
    logger: log.scope('project-domain'),
  });
  let languageHost: Awaited<ReturnType<typeof createLanguageHost>> | undefined;
  let runtime: CortxRuntime | undefined;
  try {
    await projectDomain.start();
    for (const source of config.plugins ?? []) await submitPluginSource(projectDomain, source);
    languageHost = await createLanguageHost(config, projectDomain, log);
    runtime = new CortxRuntime({
      language: languageHost.language,
      model: config.model,
      system: config.system,
      maxIterations: config.maxIterations,
      projectDomain,
      contributions: config.contributions,
      defaultWorkingDirectory: cwd,
      allowedWorkspaceRoots: [cwd],
      toolMode: 'none',
      approvalMode: 'interactive',
      logger: log,
      skillPackRegistryPath: join(cwd, '.cortx', 'skill-packs', 'registry.json'),
    });
    const session = await createLocalRuntimeSession({
      runtime,
      create: {
        workingDirectory: cwd,
        model: config.model,
        system: config.system,
        maxIterations: config.maxIterations,
        contributions: config.contributions,
        toolMode: 'none',
        approvalMode: 'interactive',
      },
    });
    return {
      session,
      topology: createStandaloneCortxTopology({ projectDomain, synax: languageHost, runtime }),
    };
  } catch (error) {
    await closeAll('Local TUI startup', [runtime, languageHost, projectDomain]).catch(() => undefined);
    throw error;
  }
}

async function submitPluginSource(projectDomain: ProjectDomain, source: string): Promise<void> {
  try {
    const mutation = await projectDomain.registry.install(source, { enabled: true });
    if (!mutation.accepted) {
      log.warn(`[tui] Plugin desired revision conflict while submitting ${source}`);
      return;
    }
    const result = await mutation.operation.wait();
    if (result.status !== 'succeeded') {
      log.warn(`[tui] Plugin ${source} is ${result.status}; administration remains available for recovery`);
    }
  } catch (error) {
    log.warn(`[tui] Plugin ${source} could not be submitted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const config = await ensureConfig();
  const cwd = config.workingDirectory ?? process.cwd();
  const composition = runtimeMode(config) === 'remote'
    ? await createRemoteComposition(config, cwd)
    : await createLocalComposition(config, cwd);
  let host: Awaited<ReturnType<typeof createTuiHost>> | undefined;
  try {
    host = await createTuiHost({ session: composition.session, logger: log.scope('tui') });
    const { waitUntilExit } = render(<App host={host} />, {
      exitOnCtrlC: false,
      patchConsole: true,
    });
    await waitUntilExit();
  } finally {
    await closeAll('TUI shutdown', [host, composition.topology, { close: async () => { await log.close(); } }]);
  }
}

async function closeAll(label: string, owners: Array<AsyncCloseable | undefined>): Promise<void> {
  const failures: unknown[] = [];
  for (const owner of owners) {
    if (!owner) continue;
    try { await owner.close(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${label} failed`);
}

main().catch(async (error) => {
  log.error(error);
  await log.close().catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
