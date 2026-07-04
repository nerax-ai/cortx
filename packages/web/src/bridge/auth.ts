const DEFAULT_BASE = '';
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 30 * 1000;

export interface AuthClient {
  token: string | null;
  tokenExpiresAt: number | null;
  apiKey: string;
  baseUrl: string;
}

export function createAuthClient(apiKey: string, baseUrl = DEFAULT_BASE): AuthClient {
  return { token: null, tokenExpiresAt: null, apiKey, baseUrl };
}

function hasUsableToken(client: AuthClient): client is AuthClient & { token: string; tokenExpiresAt: number } {
  return Boolean(client.token && client.tokenExpiresAt && client.tokenExpiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS);
}

export async function exchangeToken(client: AuthClient): Promise<string> {
  const res = await fetch(`${client.baseUrl}/auth/token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${client.apiKey}` },
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  client.token = data.token;
  client.tokenExpiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : Date.now() + DEFAULT_TOKEN_TTL_MS;
  return data.token;
}

export async function getAuthToken(client: AuthClient): Promise<string> {
  return hasUsableToken(client) ? client.token : exchangeToken(client);
}

export async function apiFetch(
  client: AuthClient,
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const bearer = await getAuthToken(client);
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> ?? {}),
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
  };
  return fetch(`${client.baseUrl}${path}`, { ...opts, headers });
}
