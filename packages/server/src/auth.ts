import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { RuntimeApprovalMode, WorkspaceToolMode } from '@cortx/runtime';

export interface ServerAuthKey {
  id?: string;
  key: string;
  allowedWorkspaceRoots?: string[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
}

export interface ServerAuthConfig {
  apiKey: string;
  apiKeys?: ServerAuthKey[];
}

export interface AuthPrincipal {
  id: string;
  allowedWorkspaceRoots?: string[];
  toolMode?: WorkspaceToolMode;
  approvalMode?: RuntimeApprovalMode;
}

interface TokenEntry {
  token: string;
  expiresAt: number;
  principal: AuthPrincipal;
}

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const AUTH_PRINCIPAL_KEY = 'cortxAuthPrincipal';

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

function normalizeAuthConfig(config: string | ServerAuthConfig): Array<ServerAuthKey & { id: string }> {
  const base = typeof config === 'string' ? { apiKey: config } : config;
  const entries: ServerAuthKey[] = [{ id: 'default', key: base.apiKey }, ...(base.apiKeys ?? [])];
  const keys = new Map<string, ServerAuthKey & { id: string }>();

  for (const [index, entry] of entries.entries()) {
    if (!entry.key) continue;
    keys.set(entry.key, {
      ...entry,
      id: entry.id ?? `key-${index}`,
    });
  }

  return [...keys.values()];
}

function principalFor(entry: ServerAuthKey & { id: string }): AuthPrincipal {
  return {
    id: entry.id,
    allowedWorkspaceRoots: entry.allowedWorkspaceRoots,
    toolMode: entry.toolMode,
    approvalMode: entry.approvalMode,
  };
}

function setAuthPrincipal(c: Context, principal: AuthPrincipal): void {
  c.set(AUTH_PRINCIPAL_KEY, principal);
}

export function getAuthPrincipal(c: Context): AuthPrincipal | undefined {
  return c.get(AUTH_PRINCIPAL_KEY) as AuthPrincipal | undefined;
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
export function createAuthMiddleware(config: string | ServerAuthConfig, store: TokenStore = createTokenStore()) {
  const apiKeys = normalizeAuthConfig(config);
  return createMiddleware(async (c: Context, next: Next) => {
    // Health endpoint is always accessible
    if (c.req.path === '/health') return next();

    const providedKey = extractApiKey(c);

    // Check if it's an API key directly.
    const directKey = apiKeys.find((entry) => entry.key === providedKey);
    if (directKey) {
      setAuthPrincipal(c, principalFor(directKey));
      return next();
    }

    // Check if it's a short-lived token
    if (providedKey) {
      cleanupExpiredTokens(store);
      const entry = store.tokens.get(providedKey);
      if (entry && entry.expiresAt > Date.now()) {
        setAuthPrincipal(c, entry.principal);
        return next();
      }
    }

    return c.json({ error: 'Unauthorized' }, 401 as import('hono/utils/http-status').ContentfulStatusCode);
  });
}

/**
 * POST /auth/token — exchange API key for short-lived token.
 */
export function handleTokenExchange(config: string | ServerAuthConfig, store: TokenStore = createTokenStore()) {
  const apiKeys = normalizeAuthConfig(config);
  return (c: Context) => {
    const providedKey = extractApiKey(c);
    const directKey = apiKeys.find((entry) => entry.key === providedKey);
    if (!directKey) {
      return c.json({ error: 'Unauthorized' }, 401 as import('hono/utils/http-status').ContentfulStatusCode);
    }

    cleanupExpiredTokens(store);
    const token = generateToken();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    store.tokens.set(token, { token, expiresAt, principal: principalFor(directKey) });

    return c.json({ token, expiresAt });
  };
}

export function createAuthHandlers(config: string | ServerAuthConfig) {
  const store = createTokenStore();
  return {
    middleware: createAuthMiddleware(config, store),
    tokenExchange: handleTokenExchange(config, store),
  };
}
