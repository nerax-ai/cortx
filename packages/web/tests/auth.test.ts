import { afterEach, describe, expect, test } from 'bun:test';
import { apiFetch, createAuthClient, exchangeToken } from '../src/bridge/auth';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('web auth bridge', () => {
  test('exchangeToken stores the returned token', async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('/auth/token');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
      return new Response(JSON.stringify({ token: 'session-token' }), { status: 200 });
    }) as typeof fetch;

    const client = createAuthClient('test-key');
    await expect(exchangeToken(client)).resolves.toBe('session-token');
    expect(client.token).toBe('session-token');
    expect(client.tokenExpiresAt).toBeGreaterThan(Date.now() - 1000);
  });

  test('apiFetch prefers exchanged token over api key', async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('/sessions');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const client = createAuthClient('api-key');
    client.token = 'session-token';
    client.tokenExpiresAt = Date.now() + 60_000;
    const response = await apiFetch(client, '/sessions');
    expect(response.ok).toBe(true);
  });

  test('apiFetch refreshes expired short-lived tokens', async () => {
    const calls: Array<{ path: string; auth: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        path: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
      });
      if (String(input) === '/auth/token') {
        return new Response(JSON.stringify({ token: 'fresh-token', expiresAt: Date.now() + 60_000 }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const client = createAuthClient('api-key');
    client.token = 'expired-token';
    client.tokenExpiresAt = Date.now() - 1;

    const response = await apiFetch(client, '/sessions');

    expect(response.ok).toBe(true);
    expect(calls).toEqual([
      { path: '/auth/token', auth: 'Bearer api-key' },
      { path: '/sessions', auth: 'Bearer fresh-token' },
    ]);
    expect(client.token).toBe('fresh-token');
  });

  test('exchangeToken surfaces auth failures', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;

    await expect(exchangeToken(createAuthClient('bad-key'))).rejects.toThrow('Auth failed: 401');
  });
});
