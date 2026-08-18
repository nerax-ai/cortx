import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createAuthMiddleware } from '../src/auth';
import { assertServerRequestSecurity, resolvePluginAdminContext } from '../src/security';
import type { ServerConfig } from '../src/types';

const baseConfig = {
  apiKey: 'root-key',
  language: {} as ServerConfig['language'],
  model: 'test-model',
} as ServerConfig;

describe('server security', () => {
  test('rejects non-loopback plaintext and spoofed forwarding headers', async () => {
    const app = securedApp(baseConfig);
    expect((await app.request('http://server.local/probe', {}, { remoteAddress: '203.0.113.4' })).status).toBe(403);
    expect(
      (
        await app.request(
          'http://server.local/probe',
          { headers: { 'x-forwarded-proto': 'https' } },
          { remoteAddress: '203.0.113.4' },
        )
      ).status,
    ).toBe(403);
  });

  test('accepts HTTPS from a configured trusted proxy only', async () => {
    const config = {
      ...baseConfig,
      security: { trustedProxy: { addresses: ['10.0.0.2'] } },
    } satisfies ServerConfig;
    const app = securedApp(config);
    const accepted = await app.request(
      'http://server.local/probe',
      { headers: { 'x-forwarded-proto': 'https' } },
      { remoteAddress: '10.0.0.2' },
    );
    expect(accepted.status).toBe(200);
  });

  test('builds PluginAdmin context only from the authenticated principal', async () => {
    const config = {
      ...baseConfig,
      apiKeys: [
        {
          id: 'observer',
          key: 'observer-key',
          pluginGrants: ['plugins.inspect', 'plugins.observe'],
        },
      ],
    } satisfies ServerConfig;
    const app = new Hono();
    app.use('*', createAuthMiddleware(config));
    app.get('/context', (c) => c.json(resolvePluginAdminContext(c, config)));

    const response = await app.request(
      '/context',
      {
        headers: {
          Authorization: 'Bearer observer-key',
          'x-cortx-principal-id': 'forged-admin',
          'x-cortx-plugin-grants': 'plugins.manage',
          'x-cortx-plugin-client': 'agent',
        },
      },
      { remoteAddress: '127.0.0.1' },
    );
    expect(await response.json()).toEqual({
      principalId: 'observer',
      grants: ['plugins.inspect', 'plugins.observe'],
      transport: 'http',
    });
  });
});

function securedApp(config: ServerConfig): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    try {
      assertServerRequestSecurity(c, config);
      await next();
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 403);
    }
  });
  app.get('/probe', (c) => c.json({ ok: true }));
  return app;
}
