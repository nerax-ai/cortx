import { afterEach, describe, expect, test } from 'bun:test';
import { apiFetch, createAuthClient } from '../src/bridge/auth';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('web auth bridge', () => {
  test('apiFetch sends the configured API key directly as a Bearer credential', async () => {
    const calls: Array<{ path: string; auth: string | null; contentType: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        path: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
        contentType: new Headers(init?.headers).get('Content-Type'),
      });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const client = createAuthClient('api-key');
    const response = await apiFetch(client, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ model: 'default' }),
    });

    expect(response.ok).toBe(true);
    expect(calls).toEqual([
      {
        path: '/sessions',
        auth: 'Bearer api-key',
        contentType: 'application/json',
      },
    ]);
  });

  test('apiFetch preserves caller headers without performing a token exchange', async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('https://cortx.example.test/sessions');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer api-key');
      expect(headers.get('Accept')).toBe('application/json');
      expect(headers.get('Content-Type')).toBeNull();
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await apiFetch(createAuthClient('api-key', 'https://cortx.example.test/'), '/sessions', {
      headers: { Accept: 'application/json' },
    });
  });

  test('rejects credentials embedded in the server URL', () => {
    expect(() => createAuthClient('api-key', 'https://user:password@cortx.example.test')).toThrow(
      'must not contain credentials',
    );
  });
});
