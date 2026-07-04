import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { noopLogger, type AgentEvent, type RuntimeAgentEventEnvelope } from '@cortx/sdk';
import { CortxRuntime, isRuntimeError, RuntimeError, type RuntimeSessionCreateRequest } from '@cortx/runtime';
import type { ServerConfig } from './types.js';
import { createAuthHandlers } from './auth.js';

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

export function createServerRuntime(config: ServerConfig): ServerRuntimeHandle {
  const app = new Hono();
  const logger = config.logger ?? noopLogger;

  if (config.host === '0.0.0.0') {
    logger.warn('[server] Binding to 0.0.0.0 — server accessible from network. Ensure TLS is configured.');
  }
  const auth = createAuthHandlers(config.apiKey);

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
    allowedWorkspaceRoots: config.allowedWorkspaceRoots,
    toolMode: config.toolMode,
    approvalMode: config.approvalMode ?? 'interactive',
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
      const session = await runtime.createSession(body as RuntimeSessionCreateRequest);
      return c.json({ sessionId: session.id, session }, 201);
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // List sessions
  app.get('/sessions', (c) => {
    return c.json({ sessions: runtime.listSessions() });
  });

  // Get session info
  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ session: runtime.getSession(id) });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // Send prompt
  app.post('/sessions/:id/prompt', async (c) => {
    const id = c.req.param('id');
    try {
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
      await runtime.resume(id);
      return c.json({ ok: true });
    } catch (error) {
      const response = errorResponse(error);
      return c.json(response.body, response.status);
    }
  });

  // Abort session
  app.post('/sessions/:id/abort', (c) => {
    const id = c.req.param('id');
    try {
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
  app.get('/sessions/:id/events', (c) => {
    const id = c.req.param('id');
    try {
      runtime.getSession(id);
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
  app.delete('/sessions/:id', (c) => {
    const id = c.req.param('id');
    try {
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
