import { describe, test, expect } from 'bun:test';
import { handleTokenExchange, extractApiKey } from '../src/auth';
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
});
