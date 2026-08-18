import type { PluginAdminAction, PluginAdminService } from '@synax-ai/sdk';
import type { Hono } from 'hono';
import type { ServerConfig } from './types.js';
import { resolvePluginAdminContext } from './security.js';

export function mountPluginAdminHttp(
  app: Hono<any>,
  options: { service: PluginAdminService; config: ServerConfig },
): void {
  app.post('/api/plugins/actions', async (c) => {
    try {
      const context = resolvePluginAdminContext(c, options.config);
      const action = await c.req.json<PluginAdminAction>();
      const result = await options.service.execute(action, context);
      return c.json(result, result.ok ? 200 : statusFor(result.error.code));
    } catch (error) {
      return transportError(c, error);
    }
  });

  app.get('/api/plugins/snapshot', (c) => executeRead(c, options, { type: 'snapshot.get' }));
  app.get('/api/plugins/catalog', (c) => executeRead(c, options, { type: 'catalog.list' }));
  app.get('/api/plugins/descriptors', (c) =>
    executeRead(c, options, {
      type: 'descriptor.list',
      contributionType: c.req.query('type') || undefined,
    }),
  );
  app.get('/api/plugins/lock', (c) => executeRead(c, options, { type: 'lock.export' }));

  app.get('/api/plugins/events', async (c) => {
    try {
      const context = resolvePluginAdminContext(c, options.config);
      const afterCursor = optionalInteger(c.req.query('afterCursor'), 'afterCursor', 0);
      const capacity = optionalInteger(c.req.query('capacity'), 'capacity', 1);
      const subscription = await options.service.subscribe({ afterCursor, capacity }, context);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const abort = () => void subscription.return().catch(() => undefined);
          c.req.raw.signal.addEventListener('abort', abort, { once: true });
          try {
            for await (const delivery of subscription) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(delivery)}\n\n`));
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          } finally {
            c.req.raw.signal.removeEventListener('abort', abort);
            await subscription.return().catch(() => undefined);
          }
        },
        cancel() {
          return subscription.return().then(() => undefined);
        },
      });
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (error) {
      return transportError(c, error);
    }
  });
}

async function executeRead(
  c: any,
  options: { service: PluginAdminService; config: ServerConfig },
  action: PluginAdminAction,
) {
  try {
    const result = await options.service.execute(action, resolvePluginAdminContext(c, options.config));
    return c.json(result, result.ok ? 200 : statusFor(result.error.code));
  } catch (error) {
    return transportError(c, error);
  }
}

function statusFor(code: string): 400 | 403 | 404 | 409 | 429 | 500 | 504 {
  if (code === 'forbidden' || code === 'transport_security') return 403;
  if (code === 'not_found') return 404;
  if (code === 'revision_conflict') return 409;
  if (code === 'subscription_limit') return 429;
  if (code === 'observation_timeout') return 504;
  if (code === 'invalid_request') return 400;
  return 500;
}

function optionalInteger(value: string | undefined, label: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw invalidRequest(`${label} must be an integer >= ${minimum}`);
  return parsed;
}

function transportError(c: any, error: unknown) {
  const source = error as { code?: string; message?: string };
  const status = source.code === 'transport_security' ? 403 : source.code === 'invalid_request' ? 400 : 500;
  return c.json({ error: source.message ?? 'Plugin administration transport failed' }, status);
}

function invalidRequest(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}
