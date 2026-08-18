import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createAuthMiddleware, extractApiKey, getAuthPrincipal } from '../src/auth';
import type { Context } from 'hono';

function mockContext(headers: Record<string, string> = {}, url = 'http://localhost/sessions'): Context {
  return {
    req: {
      url,
      path: new URL(url).pathname,
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
  } as unknown as Context;
}

describe('auth', () => {
  test('accepts only Authorization bearer credentials', () => {
    expect(extractApiKey(mockContext({ Authorization: 'Bearer test-key' }))).toBe('test-key');
    expect(extractApiKey(mockContext({}, 'http://localhost/sessions?key=test-key'))).toBeNull();
    expect(extractApiKey(mockContext({}, 'http://localhost/sessions?token=test-key'))).toBeNull();
  });

  test('rejects credential-bearing URLs before authentication', async () => {
    const app = new Hono();
    app.use('*', createAuthMiddleware('test-key'));
    app.get('/sessions', (c) => c.json({ ok: true }));

    expect((await app.request('/sessions?key=test-key')).status).toBe(400);
    expect((await app.request('/sessions?access_token=test-key')).status).toBe(400);
    expect(
      (await app.request('/sessions?monkey=allowed', { headers: { Authorization: 'Bearer test-key' } })).status,
    ).toBe(200);
  });

  test('derives a trusted principal with ceilings from the matched key', async () => {
    const app = new Hono();
    app.use(
      '*',
      createAuthMiddleware({
        apiKey: 'root-key',
        apiKeys: [
          {
            id: 'project-a',
            key: 'key-a',
            allowedWorkspaceRoots: ['/repo/a'],
            allowedContributions: ['test.plugin/tool'],
            allowedToolProfiles: ['test.plugin/read-only'],
            capabilities: { skills: true, subAgents: false, approval: true },
            approvalMode: 'interactive',
            pluginGrants: ['plugins.inspect', 'plugins.observe'],
          },
        ],
      }),
    );
    app.get('/principal', (c) => c.json({ principal: getAuthPrincipal(c) }));

    const response = await app.request('/principal', { headers: { Authorization: 'Bearer key-a' } });
    expect(await response.json()).toEqual({
      principal: {
        id: 'project-a',
        isAdmin: false,
        allowedWorkspaceRoots: ['/repo/a'],
        allowedContributions: ['test.plugin/tool'],
        allowedToolProfiles: ['test.plugin/read-only'],
        capabilities: { skills: true, subAgents: false, approval: true },
        approvalMode: 'interactive',
        pluginGrants: ['plugins.inspect', 'plugins.observe'],
      },
    });
  });

  test('ignores forged identity and grant headers', async () => {
    const app = new Hono();
    app.use('*', createAuthMiddleware({ apiKey: 'root-key', apiKeys: [{ id: 'agent', key: 'agent-key' }] }));
    app.get('/principal', (c) => c.json({ principal: getAuthPrincipal(c) }));

    const response = await app.request('/principal', {
      headers: {
        Authorization: 'Bearer agent-key',
        'x-cortx-principal-id': 'operator',
        'x-cortx-plugin-grants': 'plugins.manage',
      },
    });
    expect(await response.json()).toEqual({ principal: { id: 'agent', isAdmin: false, pluginGrants: [] } });
  });
});
