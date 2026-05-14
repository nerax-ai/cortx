const DEFAULT_BASE = '';

export interface AuthClient {
  token: string | null;
  apiKey: string;
  baseUrl: string;
}

export function createAuthClient(apiKey: string, baseUrl = DEFAULT_BASE): AuthClient {
  return { token: null, apiKey, baseUrl };
}

export async function exchangeToken(client: AuthClient): Promise<string> {
  const res = await fetch(`${client.baseUrl}/auth/token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${client.apiKey}` },
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  client.token = data.token;
  return data.token;
}

export async function apiFetch(
  client: AuthClient,
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> ?? {}),
    Authorization: `Bearer ${client.token ?? client.apiKey}`,
    'Content-Type': 'application/json',
  };
  return fetch(`${client.baseUrl}${path}`, { ...opts, headers });
}
