import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { parseCortxContributionReference, type CortxContributionConfig } from '@cortx/sdk';
import type { PluginAdminGrant } from '@synax-ai/sdk';
import type {
  RuntimeApprovalMode,
  RuntimeDefaultCapabilities,
} from '@cortx/runtime';

export interface ServerAuthKey {
  id?: string;
  key: string;
  admin?: boolean;
  allowedWorkspaceRoots?: string[];
  allowedContributions?: string[];
  allowedToolProfiles?: string[];
  capabilities?: RuntimeDefaultCapabilities;
  approvalMode?: RuntimeApprovalMode;
  pluginGrants?: PluginAdminGrant[];
}

export interface ServerAuthConfig {
  apiKey: string;
  apiKeys?: ServerAuthKey[];
}

export interface AuthPrincipal {
  id: string;
  isAdmin: boolean;
  allowedWorkspaceRoots?: string[];
  allowedContributions?: string[];
  allowedToolProfiles?: string[];
  capabilities?: RuntimeDefaultCapabilities;
  approvalMode?: RuntimeApprovalMode;
  pluginGrants: PluginAdminGrant[];
}

const AUTH_PRINCIPAL_KEY = 'cortxAuthPrincipal';
const ALL_PLUGIN_GRANTS: PluginAdminGrant[] = ['plugins.inspect', 'plugins.observe', 'plugins.manage'];
const CREDENTIAL_QUERY_FIELDS = new Set([
  'token',
  'credential',
  'authorization',
  'key',
  'api-key',
  'api_key',
  'apikey',
  'access-token',
  'access_token',
]);

function normalizeAuthConfig(config: string | ServerAuthConfig): Array<ServerAuthKey & { id: string; admin: boolean }> {
  const base = typeof config === 'string' ? { apiKey: config } : config;
  const entries: ServerAuthKey[] = [
    { id: 'default', key: base.apiKey, admin: true, pluginGrants: ALL_PLUGIN_GRANTS },
    ...(base.apiKeys ?? []),
  ];
  const keys = new Map<string, ServerAuthKey & { id: string; admin: boolean }>();

  for (const [index, entry] of entries.entries()) {
    if (!entry.key) continue;
    validateCanonicalList(entry.allowedContributions, 'allowedContributions');
    validateCanonicalList(entry.allowedToolProfiles, 'allowedToolProfiles');
    keys.set(entry.key, {
      ...entry,
      id: entry.id ?? `key-${index}`,
      admin: entry.admin === true,
    });
  }
  return [...keys.values()];
}

function principalFor(entry: ServerAuthKey & { id: string; admin: boolean }): AuthPrincipal {
  return {
    id: entry.id,
    isAdmin: entry.admin,
    allowedWorkspaceRoots: clone(entry.allowedWorkspaceRoots),
    allowedContributions: clone(entry.allowedContributions),
    allowedToolProfiles: clone(entry.allowedToolProfiles),
    capabilities: entry.capabilities ? { ...entry.capabilities } : undefined,
    approvalMode: entry.approvalMode,
    pluginGrants: entry.admin ? [...ALL_PLUGIN_GRANTS] : [...(entry.pluginGrants ?? [])],
  };
}

function setAuthPrincipal(c: Context, principal: AuthPrincipal): void {
  c.set(AUTH_PRINCIPAL_KEY, principal);
}

export function getAuthPrincipal(c: Context): AuthPrincipal | undefined {
  return c.get(AUTH_PRINCIPAL_KEY) as AuthPrincipal | undefined;
}

export function extractApiKey(c: Context): string | null {
  const match = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function rejectCredentialQuery(rawUrl: string): void {
  const url = new URL(rawUrl);
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_FIELDS.has(key.toLowerCase())) {
      throw Object.assign(new Error('Credentials are forbidden in URLs'), { code: 'invalid_request' });
    }
  }
}

export function configuredAuthPrincipals(config: ServerAuthConfig): AuthPrincipal[] {
  return normalizeAuthConfig(config).map(principalFor);
}

export function createAuthMiddleware(config: string | ServerAuthConfig) {
  const apiKeys = normalizeAuthConfig(config);
  return createMiddleware(async (c: Context, next: Next) => {
    try {
      rejectCredentialQuery(c.req.url);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400 as import('hono/utils/http-status').ContentfulStatusCode,
      );
    }
    if (c.req.path === '/health') return next();

    const providedKey = extractApiKey(c);
    const matched = providedKey
      ? apiKeys.find((entry) => constantTimeEqual(entry.key, providedKey))
      : undefined;
    if (!matched) {
      return c.json({ error: 'Unauthorized' }, 401 as import('hono/utils/http-status').ContentfulStatusCode);
    }
    setAuthPrincipal(c, principalFor(matched));
    return next();
  });
}

export function principalContributionConfigs(
  contributions: readonly CortxContributionConfig[],
  principal: AuthPrincipal | undefined,
): CortxContributionConfig[] {
  if (!principal?.allowedContributions) return contributions.map((entry) => ({ ...entry }));
  const allowed = new Set(principal.allowedContributions);
  return contributions.filter((entry) => allowed.has(entry.use)).map((entry) => ({ ...entry }));
}

function validateCanonicalList(values: string[] | undefined, field: string): void {
  for (const value of values ?? []) {
    try {
      parseCortxContributionReference(value);
    } catch {
      throw new Error(`${field} must contain canonical contribution references: ${value}`);
    }
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < max; index++) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function clone(values: string[] | undefined): string[] | undefined {
  return values ? [...values] : undefined;
}
