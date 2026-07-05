import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { handleTokenExchange, extractApiKey, createAuthHandlers, getAuthPrincipal } from '../src/auth';
import type { Context } from 'hono';

function mockContext(headers: Record<string, string> = {}, query: Record<string, string> = {}): Context {
  return {
    req: {
      header: (name: string) => headers[name] ?? null,
      query: (name: string) => query[name] ?? null,
    },
    json: (body: unknown, status = 200) => ({ body, status }),
  } as unknown as Context;
}

describe('auth', () => {
  const apiKey = 'test-api-key-12345';

  test('extractApiKey from Authorization header', () => {
    const ctx = mockContext({ Authorization: 'Bearer test-api-key-12345' });
    expect(extractApiKey(ctx)).toBe('test-api-key-12345');
  });

  test('extractApiKey from query parameter', () => {
    const ctx = mockContext({}, { key: 'test-api-key-12345' });
    expect(extractApiKey(ctx)).toBe('test-api-key-12345');
  });

  test('extractApiKey returns null when no auth provided', () => {
    const ctx = mockContext();
    expect(extractApiKey(ctx)).toBeNull();
  });

  test('handleTokenExchange returns token for valid API key', () => {
    const handler = handleTokenExchange(apiKey);
    const ctx = mockContext({ Authorization: 'Bearer test-api-key-12345' });
    const result = handler(ctx) as { body: { token: string; expiresAt: number }; status: number };
    expect(result.status).toBe(200);
    expect(result.body.token).toBeTruthy();
    expect(result.body.expiresAt).toBeGreaterThan(Date.now() - 1000);
  });

  test('handleTokenExchange rejects invalid API key', () => {
    const handler = handleTokenExchange(apiKey);
    const ctx = mockContext({ Authorization: 'Bearer wrong-key' });
    const result = handler(ctx) as { body: { error: string }; status: number };
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('Unauthorized');
  });

  test('short-lived tokens are scoped to one auth handler instance', async () => {
    const first = createAuthHandlers('first-key');
    const second = createAuthHandlers('second-key');
    const firstApp = new Hono();
    const secondApp = new Hono();

    firstApp.use('*', first.middleware);
    firstApp.post('/auth/token', first.tokenExchange);
    firstApp.get('/sessions', (c) => c.json({ ok: true }));
    secondApp.use('*', second.middleware);
    secondApp.get('/sessions', (c) => c.json({ ok: true }));

    const tokenRes = await firstApp.request('/auth/token', {
      method: 'POST',
      headers: { Authorization: 'Bearer first-key' },
    });
    const { token } = (await tokenRes.json()) as { token: string };

    const sameServer = await firstApp.request(`/sessions?token=${token}`);
    const otherServer = await secondApp.request(`/sessions?token=${token}`);

    expect(sameServer.status).toBe(200);
    expect(otherServer.status).toBe(401);
  });

  test('multiple API keys expose scoped principals and tokens inherit the same scope', async () => {
    const auth = createAuthHandlers({
      apiKey: 'primary-key',
      apiKeys: [
        {
          id: 'project-a',
          key: 'key-a',
          allowedWorkspaceRoots: ['/repo/a'],
          toolMode: 'read-only',
          approvalMode: 'interactive',
        },
        {
          id: 'project-b',
          key: 'key-b',
          allowedWorkspaceRoots: ['/repo/b'],
          toolMode: 'all',
          approvalMode: 'full-access',
        },
      ],
    });
    const app = new Hono();

    app.use('*', auth.middleware);
    app.post('/auth/token', auth.tokenExchange);
    app.get('/principal', (c) => c.json({ principal: getAuthPrincipal(c) }));

    const direct = await app.request('/principal', {
      headers: { Authorization: 'Bearer key-a' },
    });
    expect(await direct.json()).toEqual({
      principal: {
        id: 'project-a',
        allowedWorkspaceRoots: ['/repo/a'],
        toolMode: 'read-only',
        approvalMode: 'interactive',
      },
    });

    const tokenRes = await app.request('/auth/token', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-b' },
    });
    const { token } = (await tokenRes.json()) as { token: string };
    const viaToken = await app.request(`/principal?token=${token}`);

    expect(await viaToken.json()).toEqual({
      principal: {
        id: 'project-b',
        allowedWorkspaceRoots: ['/repo/b'],
        toolMode: 'all',
        approvalMode: 'full-access',
      },
    });
  });

  test('explicit API key entries can scope the default API key', async () => {
    const auth = createAuthHandlers({
      apiKey: 'primary-key',
      apiKeys: [{ id: 'scoped-primary', key: 'primary-key', allowedWorkspaceRoots: ['/repo/scoped'] }],
    });
    const app = new Hono();
    app.use('*', auth.middleware);
    app.get('/principal', (c) => c.json({ principal: getAuthPrincipal(c) }));

    const res = await app.request('/principal', {
      headers: { Authorization: 'Bearer primary-key' },
    });

    expect(await res.json()).toEqual({
      principal: {
        id: 'scoped-primary',
        allowedWorkspaceRoots: ['/repo/scoped'],
      },
    });
  });
});
