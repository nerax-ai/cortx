import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { dirname, resolve } from 'node:path';
import { noopLogger, type AgentEvent, type RuntimeAgentEventEnvelope } from '@cortx/sdk';
import {
  CortxRuntime,
  discoverAgentSpecs,
  isRuntimeError,
  loadAgentSpecFile,
  parseAgentSpec,
  resolveWorkspace,
  RuntimeError,
  type AgentSpec,
  type DiscoveredAgentSpec,
  type RuntimeApprovalMode,
  type RuntimeSessionCreateRequest,
  type RuntimeSessionInfo,
  type WorkspaceToolMode,
} from '@cortx/runtime';
import type { ServerConfig } from './types.js';
import { createAuthHandlers, getAuthPrincipal, type AuthPrincipal } from './auth.js';

export interface ServerRuntimeHandle {
  app: Hono;
  runtime: CortxRuntime;
  dispose(): void;
}

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

function getPrincipalAllowedWorkspaceRoots(config: ServerConfig, principal: AuthPrincipal | undefined): string[] {
  return principal?.allowedWorkspaceRoots?.length ? principal.allowedWorkspaceRoots : getServerAllowedWorkspaceRoots(config);
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

async function assertSessionAccess(c: Context, config: ServerConfig, session: RuntimeSessionInfo): Promise<void> {
  await authorizeWorkspace(config, getAuthPrincipal(c), session.workingDirectory);
}

async function getAuthorizedSession(
  runtime: CortxRuntime,
  c: Context,
  config: ServerConfig,
  id: string,
): Promise<RuntimeSessionInfo> {
  const session = runtime.getSession(id);
  await assertSessionAccess(c, config, session);
  return session;
}

async function listAuthorizedSessions(runtime: CortxRuntime, c: Context, config: ServerConfig): Promise<RuntimeSessionInfo[]> {
  const visible: RuntimeSessionInfo[] = [];
  for (const session of runtime.listSessions()) {
    try {
      await assertSessionAccess(c, config, session);
      visible.push(session);
    } catch (error) {
      if (isRuntimeError(error) && error.kind === 'permission_denied') continue;
      throw error;
    }
  }
  return visible;
}

async function listAuthorizedAgentSpecs(c: Context, config: ServerConfig): Promise<DiscoveredAgentSpec[]> {
  const principal = getAuthPrincipal(c);
  const discovered = await discoverAgentSpecs({
    roots: getPrincipalAllowedWorkspaceRoots(config, principal),
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

async function launchAgentSpecPath(runtime: CortxRuntime, config: ServerConfig, c: Context, path: string) {
  const principal = getAuthPrincipal(c);
  const defaultWorkingDirectory = config.defaultWorkingDirectory ?? process.cwd();
  const specPath = resolve(defaultWorkingDirectory, path);
  await authorizeWorkspace(config, principal, dirname(specPath));
  return launchAgentSpecSafely(async () => {
    const spec = await loadAgentSpecFile(specPath);
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
    const spec = parseAgentSpec(value);
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
    system: config.system,
    maxIterations: config.maxIterations,
    registry: config.registry,
    plugins: config.plugins,
    defaultWorkingDirectory: config.defaultWorkingDirectory,
    allowedWorkspaceRoots: getRuntimeAllowedWorkspaceRoots(config),
    toolMode: config.toolMode,
    approvalMode: config.approvalMode ?? 'interactive',
    durableStore: config.durableStore,
    logger,
  });

  // CORS
  app.use('*', cors({ origin: config.corsOrigin ?? '*' }));

  // Auth middleware (applies to all routes except health)
  app.use('*', auth.middleware);

  // Health check
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      sessions: runtime.listSessions().length,
    });
  });

  // Token exchange
  app.post('/auth/token', auth.tokenExchange);

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
      runtime.abort(id);
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
      runtime.answer(id, body.toolCallId, body.response);
      return c.json({ ok: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // SSE event stream
  app.get('/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    try {
      await getAuthorizedSession(runtime, c, config, id);
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }

    return streamSSE(c, async (stream) => {
      const useEnvelope = c.req.query('format') === 'envelope';
      // Replay prior events (snapshot to avoid concurrent mutation)
      const snapshot = useEnvelope ? runtime.getEventEnvelopeHistory(id) : runtime.getEventHistory(id);
      let sequence = 0;
      for (const event of snapshot) {
        const envelope = event as RuntimeAgentEventEnvelope;
        await stream.writeSSE({
          data: useEnvelope
            ? serializeEnvelope(envelope)
            : serializeEvent(event as AgentEvent),
          id: useEnvelope ? String(envelope.sequence) : String(++sequence),
        });
      }

      // Subscribe to new events
      const unsub = useEnvelope
        ? runtime.subscribeEnvelopes(
            id,
            async (event: RuntimeAgentEventEnvelope) => {
              try {
                await stream.writeSSE({
                  data: serializeEnvelope(event),
                  id: String(event.sequence),
                });
              } catch {
                // Stream closed
              }
            },
            { replay: false },
          )
        : runtime.subscribe(
            id,
            async (event: AgentEvent) => {
              try {
                await stream.writeSSE({
                  data: serializeEvent(event),
                  id: String(++sequence),
                });
              } catch {
                // Stream closed
              }
            },
            { replay: false },
          );

      // Wait for close
      stream.onAbort(() => {
        unsub?.();
      });

      // Keep connection alive with periodic heartbeats
      try {
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
      runtime.deleteSession(id);
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
