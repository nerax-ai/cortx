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
    const response = await apiFetch(client, '/sessions');
    expect(response.ok).toBe(true);
  });

  test('exchangeToken surfaces auth failures', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;

    await expect(exchangeToken(createAuthClient('bad-key'))).rejects.toThrow('Auth failed: 401');
  });
});
