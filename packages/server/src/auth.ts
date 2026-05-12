import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

interface TokenEntry {
  token: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const tokens = new Map<string, TokenEntry>();

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token);
  }
}

/**
 * Validate API key from Authorization header or ?key= query parameter.
 */
export function extractApiKey(c: Context): string | null {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return c.req.query('key') ?? null;
}

/**
 * Auth middleware: validates API key or short-lived token.
 */
export function createAuthMiddleware(apiKey: string) {
  return createMiddleware(async (c: Context, next: Next) => {
    // Health endpoint is always accessible
    if (c.req.path === '/health') return next();

    const providedKey = extractApiKey(c);

    // Check if it's the API key directly
    if (providedKey === apiKey) return next();

    // Check if it's a short-lived token
    if (providedKey) {
      cleanupExpiredTokens();
      const entry = tokens.get(providedKey);
      if (entry && entry.expiresAt > Date.now()) return next();
    }

    return c.json({ error: 'Unauthorized' }, 401 as import('hono/utils/http-status').ContentfulStatusCode);
  });
}

/**
 * POST /auth/token — exchange API key for short-lived token.
 */
export function handleTokenExchange(apiKey: string) {
  return (c: Context) => {
    const providedKey = extractApiKey(c);
    if (providedKey !== apiKey) {
      return c.json({ error: 'Unauthorized' }, 401 as import('hono/utils/http-status').ContentfulStatusCode);
    }

    cleanupExpiredTokens();
    const token = generateToken();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    tokens.set(token, { token, expiresAt });

    return c.json({ token, expiresAt });
  };
}
