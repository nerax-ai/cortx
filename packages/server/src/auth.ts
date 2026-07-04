import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

interface TokenEntry {
  token: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
interface TokenStore {
  tokens: Map<string, TokenEntry>;
}

function createTokenStore(): TokenStore {
  return { tokens: new Map() };
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanupExpiredTokens(store: TokenStore): void {
  const now = Date.now();
  for (const [token, entry] of store.tokens) {
    if (entry.expiresAt <= now) store.tokens.delete(token);
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
  return c.req.query('key') ?? c.req.query('token') ?? null;
}

/**
 * Auth middleware: validates API key or short-lived token.
 */
export function createAuthMiddleware(apiKey: string, store: TokenStore = createTokenStore()) {
  return createMiddleware(async (c: Context, next: Next) => {
    // Health endpoint is always accessible
    if (c.req.path === '/health') return next();

    const providedKey = extractApiKey(c);

    // Check if it's the API key directly
    if (providedKey === apiKey) return next();

    // Check if it's a short-lived token
    if (providedKey) {
      cleanupExpiredTokens(store);
      const entry = store.tokens.get(providedKey);
      if (entry && entry.expiresAt > Date.now()) return next();
    }

    return c.json({ error: 'Unauthorized' }, 401 as import('hono/utils/http-status').ContentfulStatusCode);
  });
}

/**
 * POST /auth/token — exchange API key for short-lived token.
 */
export function handleTokenExchange(apiKey: string, store: TokenStore = createTokenStore()) {
  return (c: Context) => {
    const providedKey = extractApiKey(c);
    if (providedKey !== apiKey) {
      return c.json({ error: 'Unauthorized' }, 401 as import('hono/utils/http-status').ContentfulStatusCode);
    }

    cleanupExpiredTokens(store);
    const token = generateToken();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    store.tokens.set(token, { token, expiresAt });

    return c.json({ token, expiresAt });
  };
}

export function createAuthHandlers(apiKey: string) {
  const store = createTokenStore();
  return {
    middleware: createAuthMiddleware(apiKey, store),
    tokenExchange: handleTokenExchange(apiKey, store),
  };
}
