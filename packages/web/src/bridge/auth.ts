const DEFAULT_BASE = '';

export interface AuthClient {
  apiKey: string;
  baseUrl: string;
}

export function createAuthClient(apiKey: string, baseUrl = DEFAULT_BASE): AuthClient {
  return { apiKey, baseUrl: normalizeBaseUrl(baseUrl) };
}

function authHeaders(client: AuthClient, input?: HeadersInit): Headers {
  const headers = new Headers(input);
  headers.set('Authorization', `Bearer ${client.apiKey}`);
  return headers;
}

export async function apiFetch(client: AuthClient, path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = authHeaders(client, opts.headers);
  if (opts.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${client.baseUrl}${path}`, { ...opts, headers });
}

function normalizeBaseUrl(baseUrl: string): string {
  if (!baseUrl) return '';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Web API baseUrl must be an absolute HTTP(S) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Web API baseUrl must use HTTP(S)');
  }
  if (url.username || url.password) throw new Error('Web API baseUrl must not contain credentials');
  if (url.search || url.hash) throw new Error('Web API baseUrl must not contain query parameters or fragments');
  return url.toString().replace(/\/+$/, '');
}
