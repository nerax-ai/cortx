import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { noopLogger, type AgentEvent } from '@cortx/sdk';
import type { ServerConfig } from './types.js';
import { createAuthMiddleware, handleTokenExchange } from './auth.js';
import { SessionManager } from './session-manager.js';

function serializeEvent(event: AgentEvent): string {
  if (event.type === 'error' && event.error instanceof Error) {
    return JSON.stringify({ ...event, error: { message: event.error.message, name: event.error.name } });
  }
  return JSON.stringify(event);
}

export function createServer(config: ServerConfig): Hono {
  const app = new Hono();
  const logger = config.logger ?? noopLogger;

  if (config.host === '0.0.0.0') {
    logger.warn('[server] Binding to 0.0.0.0 — server accessible from network. Ensure TLS is configured.');
  }

  const manager = new SessionManager({
    maxSessions: config.maxSessions,
    idleTimeoutMs: config.idleTimeoutMs,
    language: config.language,
    model: config.model,
    system: config.system,
    registry: config.registry,
    plugins: config.plugins,
    logger,
  });

  // CORS
  app.use('*', cors({ origin: config.corsOrigin ?? '*' }));

  // Auth middleware (applies to all routes except health)
  app.use('*', createAuthMiddleware(config.apiKey));

  // Health check
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      sessions: manager.list().length,
    });
  });

  // Token exchange
  app.post('/auth/token', handleTokenExchange(config.apiKey));

  // Create session
  app.post('/sessions', async (c) => {
    const result = await manager.create();
    if ('error' in result) {
      return c.json({ error: result.error }, result.status as ContentfulStatusCode);
    }
    return c.json({ sessionId: result.id }, 201);
  });

  // List sessions
  app.get('/sessions', (c) => {
    return c.json({ sessions: manager.list() });
  });

  // Get session info
  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const sessions = manager.list().find((s) => s.id === id);
    if (!sessions) return c.json({ error: 'Session not found' }, 404 as ContentfulStatusCode);
    return c.json({ session: sessions });
  });

  // Send prompt
  app.post('/sessions/:id/prompt', async (c) => {
    const id = c.req.param('id');
    let body: { message?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400 as ContentfulStatusCode);
    }
    const result = await manager.prompt(id, body.message ?? '');
    if (result) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
    return c.json({ ok: true });
  });

  // Abort session
  app.post('/sessions/:id/abort', (c) => {
    const id = c.req.param('id');
    const result = manager.abort(id);
    if (result) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
    return c.json({ ok: true });
  });

  // Answer askUser question
  app.post('/sessions/:id/answer', async (c) => {
    const id = c.req.param('id');
    let body: { toolCallId?: string; response?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400 as ContentfulStatusCode);
    }
    if (!body.toolCallId || !body.response) {
      return c.json({ error: 'toolCallId and response are required' }, 400 as ContentfulStatusCode);
    }
    const result = manager.answer(id, body.toolCallId, body.response);
    if (result) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
    return c.json({ ok: true });
  });

  // SSE event stream
  app.get('/sessions/:id/events', (c) => {
    const id = c.req.param('id');
    const session = manager.get(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    return streamSSE(c, async (stream) => {
      // Replay prior events (snapshot to avoid concurrent mutation)
      const snapshot = [...session.events];
      for (const event of snapshot) {
        await stream.writeSSE({
          data: serializeEvent(event),
          id: String(event.type === 'error' ? 0 : 0),
        });
      }

      // Subscribe to new events
      let sequence = snapshot.length;
      const unsub = manager.subscribe(id, async (event: AgentEvent) => {
        try {
          await stream.writeSSE({
            data: serializeEvent(event),
            id: String(++sequence),
          });
        } catch {
          // Stream closed
        }
      });

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
    const result = manager.delete(id);
    if (result) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
    return c.json({ ok: true });
  });

  return app;
}
