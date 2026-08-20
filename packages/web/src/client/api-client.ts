import type { RuntimeAgentEventEnvelope } from '@cortx/sdk';
import { apiFetch, createAuthClient, type AuthClient } from '../bridge/auth';
import type {
  WebAgentSpecInfo,
  WebAgentSpecLaunchRequest,
  WebCommandMetadata,
  WebCreateSessionRequest,
  WebEventHistoryResponse,
  WebModelInfo,
  WebRuntimeSessionInfo,
  WebSessionBaseline,
  WebSkillInfo,
  WebSkillPackInstallRequest,
  WebSkillPackInfo,
  WebToolProfileInfo,
  WebUpdateSessionRequest,
  WebWorkspaceDirectoryListing,
} from './types';

export class CortxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CortxApiError';
  }
}

export class CortxApiClient {
  readonly auth: AuthClient;

  constructor(apiKey = '', baseUrl = '') {
    this.auth = createAuthClient(apiKey, baseUrl);
  }

  async createSession(request: WebCreateSessionRequest = {}): Promise<WebRuntimeSessionInfo> {
    return (await this.#json<{ session: WebRuntimeSessionInfo }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    }, 'Create session failed')).session;
  }

  async updateSession(
    sessionId: string,
    request: WebUpdateSessionRequest,
    command: WebCommandMetadata,
  ): Promise<WebRuntimeSessionInfo> {
    return (await this.#json<{ session: WebRuntimeSessionInfo }>(sessionPath(sessionId), {
      method: 'PATCH',
      body: JSON.stringify({ ...request, ...command }),
    }, 'Update session failed')).session;
  }

  async getSession(sessionId: string): Promise<WebRuntimeSessionInfo> {
    return (await this.#json<{ session: WebRuntimeSessionInfo }>(sessionPath(sessionId), {}, 'Get session failed')).session;
  }

  async listSessions(): Promise<WebRuntimeSessionInfo[]> {
    return (await this.#json<{ sessions: WebRuntimeSessionInfo[] }>('/sessions', {}, 'List sessions failed')).sessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#json(sessionPath(sessionId), { method: 'DELETE' }, 'Delete session failed');
  }

  async getSessionBaseline(): Promise<WebSessionBaseline> {
    return this.#json('/sessions/feed/baseline', {}, 'Load session baseline failed');
  }

  async getEventHistory(
    sessionId: string,
    options: { after?: number; before?: number; limit?: number } = {},
  ): Promise<WebEventHistoryResponse> {
    const params = new URLSearchParams({ format: 'envelope' });
    if (options.after !== undefined) params.set('after', String(options.after));
    if (options.before !== undefined) params.set('before', String(options.before));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const response = await this.#json<WebEventHistoryResponse>(
      `${sessionPath(sessionId)}/events/history?${params.toString()}`,
      {},
      'Load event history failed',
    );
    return { ...response, events: response.events ?? [] };
  }

  async prompt(sessionId: string, message: string, command: WebCommandMetadata): Promise<WebRuntimeSessionInfo> {
    return (await this.#mutation(sessionId, 'prompt', { message, ...command })).session;
  }

  async followUp(
    sessionId: string,
    message: string,
    inputId: string,
    command: WebCommandMetadata,
  ): Promise<WebRuntimeSessionInfo> {
    return (await this.#mutation(sessionId, 'follow-up', { message, inputId, ...command })).session;
  }

  async cancelFollowUp(
    sessionId: string,
    inputId: string,
    command: WebCommandMetadata,
  ): Promise<WebRuntimeSessionInfo> {
    return (await this.#mutation(sessionId, `follow-up/${encodeURIComponent(inputId)}/cancel`, { ...command })).session;
  }

  async steer(sessionId: string, message: string, command: WebCommandMetadata): Promise<WebRuntimeSessionInfo> {
    return (await this.#mutation(sessionId, 'steer', { message, ...command })).session;
  }

  async resume(sessionId: string, command: WebCommandMetadata): Promise<WebRuntimeSessionInfo> {
    return (await this.#mutation(sessionId, 'resume', { ...command })).session;
  }

  async abort(sessionId: string, command: WebCommandMetadata): Promise<WebRuntimeSessionInfo> {
    return (await this.#mutation(sessionId, 'abort', { ...command })).session;
  }

  async answer(
    sessionId: string,
    toolCallId: string,
    response: string,
    command: WebCommandMetadata,
  ): Promise<WebRuntimeSessionInfo> {
    return (await this.#mutation(sessionId, 'answer', { toolCallId, response, ...command })).session;
  }

  async listModels(): Promise<WebModelInfo[]> {
    return (await this.#json<{ models: WebModelInfo[] }>('/models', {}, 'List models failed')).models;
  }

  async listToolProfiles(): Promise<WebToolProfileInfo[]> {
    return (await this.#json<{ toolProfiles: WebToolProfileInfo[] }>('/tool-profiles', {}, 'List tool profiles failed')).toolProfiles;
  }

  async listSessionSkills(sessionId: string): Promise<WebSkillInfo[]> {
    return (await this.#json<{ skills: WebSkillInfo[] }>(`${sessionPath(sessionId)}/skills`, {}, 'List skills failed')).skills;
  }

  async listAgentSpecs(): Promise<WebAgentSpecInfo[]> {
    return (await this.#json<{ agentSpecs: WebAgentSpecInfo[] }>('/agent-specs', {}, 'List AgentSpecs failed')).agentSpecs;
  }

  async launchAgentSpec(request: WebAgentSpecLaunchRequest): Promise<WebRuntimeSessionInfo> {
    return (await this.#json<{ session: WebRuntimeSessionInfo }>('/agent-specs/launch', {
      method: 'POST',
      body: JSON.stringify(request),
    }, 'Launch AgentSpec failed')).session;
  }

  async listSkillPacks(): Promise<WebSkillPackInfo[]> {
    return (await this.#json<{ skillPacks: WebSkillPackInfo[] }>('/skill-packs', {}, 'List SkillPacks failed')).skillPacks;
  }

  async installSkillPack(request: WebSkillPackInstallRequest): Promise<WebSkillPackInfo> {
    return (await this.#json<{ skillPack: WebSkillPackInfo }>('/skill-packs/install', {
      method: 'POST',
      body: JSON.stringify(request),
    }, 'Install SkillPack failed')).skillPack;
  }

  async listWorkspaceDirectories(path?: string): Promise<WebWorkspaceDirectoryListing> {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    const query = params.size ? `?${params.toString()}` : '';
    return this.#json(`/workspaces/directories${query}`, {}, 'Browse workspaces failed');
  }

  async #mutation(
    sessionId: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: true; session: WebRuntimeSessionInfo }> {
    return this.#json(`${sessionPath(sessionId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, `${action} failed`);
  }

  async #json<T = unknown>(path: string, init: RequestInit, fallback: string): Promise<T> {
    const response = await apiFetch(this.auth, path, init);
    if (!response.ok) {
      let body: { error?: string; kind?: string; details?: Record<string, unknown> } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        // Preserve the transport status when the body is not JSON.
      }
      throw new CortxApiError(body.error ?? `${fallback}: ${response.status}`, response.status, body.kind, body.details);
    }
    return (await response.json()) as T;
  }
}

export function isRuntimeEnvelope(value: unknown): value is RuntimeAgentEventEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.sequence === 'number' &&
    typeof record.timestamp === 'number' &&
    typeof record.sessionId === 'string' &&
    typeof record.runId === 'number' &&
    Boolean(record.event && typeof record.event === 'object');
}

function sessionPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}
