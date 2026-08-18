import {
  decodePluginAdminAction,
  normalizePluginAdminError,
  pluginAdminResultAction,
  type PluginAdminAction,
  type PluginAdminResultAction,
  type PluginAdminService,
} from '@synax-ai/sdk';
import type { Hono } from 'hono';
import type { ServerConfig } from './types.js';
import { resolvePluginAdminContext } from './security.js';

export function mountPluginAdminHttp(
  app: Hono<any>,
  options: { service: PluginAdminService; config: ServerConfig },
): void {
  app.post('/api/plugins/actions', async (c) => {
    let input: unknown;
    try {
      const context = resolvePluginAdminContext(c, options.config);
      input = await c.req.json<unknown>();
      const action = decodePluginAdminAction(input);
      const result = await options.service.execute(action, context);
      return c.json(result, result.ok ? 200 : statusFor(result.error.code));
    } catch (error) {
      return pluginAdminErrorResponse(c, pluginAdminResultAction(input), error);
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
      const encoder = new TextEncoder();
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        c.req.raw.signal.removeEventListener('abort', abort);
        await subscription.return().catch(() => undefined);
      };
      const abort = () => void close();
      c.req.raw.signal.addEventListener('abort', abort, { once: true });
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (closed) return;
            try {
              const delivery = await subscription.next();
              if (delivery.done) {
                await close();
                controller.close();
                return;
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(delivery.value)}\n\n`));
            } catch (error) {
              await close();
              controller.error(error);
            }
          },
          async cancel() {
            await close();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (error) {
      return pluginAdminErrorResponse(c, 'subscription.open', error);
    }
  });
}

async function executeRead(
  c: any,
  options: { service: PluginAdminService; config: ServerConfig },
  action: PluginAdminAction,
) {
  try {
    const decoded = decodePluginAdminAction(action);
    const result = await options.service.execute(decoded, resolvePluginAdminContext(c, options.config));
    return c.json(result, result.ok ? 200 : statusFor(result.error.code));
  } catch (error) {
    return pluginAdminErrorResponse(c, action.type, error);
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

export function isPluginAdminHttpPath(path: string): boolean {
  return path === '/api/plugins' || path.startsWith('/api/plugins/');
}

export function pluginAdminHttpAction(path: string): PluginAdminResultAction {
  if (path === '/api/plugins/snapshot') return 'snapshot.get';
  if (path === '/api/plugins/catalog') return 'catalog.list';
  if (path === '/api/plugins/descriptors') return 'descriptor.list';
  if (path === '/api/plugins/lock') return 'lock.export';
  if (path === '/api/plugins/events') return 'subscription.open';
  return 'unknown';
}

export function pluginAdminErrorResponse(c: any, action: PluginAdminResultAction, error: unknown) {
  const normalized = normalizePluginAdminError(error);
  return c.json({ ok: false as const, action, error: normalized }, statusFor(normalized.code));
}

function invalidRequest(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}
