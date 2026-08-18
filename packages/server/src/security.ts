import type { PluginAdminContext, PluginAdminGrant } from '@synax-ai/sdk';
import type { Context } from 'hono';
import { configuredAuthPrincipals, getAuthPrincipal, rejectCredentialQuery } from './auth.js';
import type { ServerConfig } from './types.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function assertServerRequestSecurity(c: Context, config: ServerConfig): void {
  rejectCredentialQuery(c.req.url);
  if (isLocalRequest(c)) return;
  if (!isSecureTransport(c, config)) {
    throw securityError('Non-loopback Cortx requests require TLS or a trusted terminating proxy');
  }
}

export function resolvePluginAdminContext(c: Context, config: ServerConfig): PluginAdminContext {
  assertServerRequestSecurity(c, config);
  if (!isAllowedOrigin(c, config)) throw securityError('Cross-origin plugin administration is forbidden');
  const principal = getAuthPrincipal(c);
  if (!principal) throw securityError('Authenticated principal is required');
  return {
    principalId: principal.id,
    grants: [...principal.pluginGrants],
    transport: pluginTransport(c),
  };
}

export function pluginAdminGrantIsCurrent(
  context: PluginAdminContext,
  config: ServerConfig,
  grant: PluginAdminGrant,
): boolean {
  if (!context.grants.includes(grant)) return false;
  if (context.principalId === 'default') return Boolean(config.apiKey);
  const principal = configuredAuthPrincipals(config).find((entry) => entry.id === context.principalId);
  if (!principal) return false;
  if (principal.isAdmin) return true;
  return principal.pluginGrants.includes(grant);
}

export function isLocalAddress(rawAddress: string | undefined | null): boolean {
  if (!rawAddress) return false;
  const address = normalizeAddress(rawAddress);
  if (LOCAL_HOSTS.has(address)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) return true;
  return address.startsWith('::ffff:127.');
}

export function isLocalRequest(c: Context): boolean {
  const remoteAddress = (c.env as { remoteAddress?: string | null } | undefined)?.remoteAddress;
  return isLocalAddress(remoteAddress);
}

export function isAllowedOrigin(c: Context, config: ServerConfig): boolean {
  const origin = c.req.header('origin');
  if (!origin) return true;
  if (sameOrigin(c.req.url, origin)) return true;
  const configured = [
    ...(config.security?.allowedOrigins ?? []),
    ...(config.corsOrigin && config.corsOrigin !== '*' ? [config.corsOrigin] : []),
  ];
  if (configured.some((allowed) => originOf(allowed) === originOf(origin))) return true;
  return config.corsOrigin === '*' && isLocalRequest(c);
}

function isSecureTransport(c: Context, config: ServerConfig): boolean {
  if (new URL(c.req.url).protocol === 'https:') return true;
  const proxy = config.security?.trustedProxy;
  const remoteAddress = (c.env as { remoteAddress?: string | null } | undefined)?.remoteAddress;
  if (!proxy || !proxy.addresses.some((address) => sameAddress(address, remoteAddress))) return false;
  const header = proxy.forwardedProtoHeader ?? 'x-forwarded-proto';
  return c.req.header(header)?.split(',')[0]?.trim().toLowerCase() === 'https';
}

function pluginTransport(c: Context): PluginAdminContext['transport'] {
  return 'http';
}

function sameOrigin(requestUrl: string, origin: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function normalizeAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.startsWith('[')) return trimmed;
  const closing = trimmed.indexOf(']');
  return closing === -1 ? trimmed : trimmed.slice(1, closing);
}

function sameAddress(expected: string, actual: string | undefined | null): boolean {
  return Boolean(actual) && normalizeAddress(expected) === normalizeAddress(actual!);
}

function securityError(message: string): Error {
  return Object.assign(new Error(message), { code: 'transport_security' });
}
