import type { AgentEvent } from '@cortx/sdk';
import { AgentStore } from '@cortx/store';
import { createAuthClient, exchangeToken, apiFetch, type AuthClient } from './auth';

export class EventBridge {
  readonly store = new AgentStore();
  private client: AuthClient;
  private eventSource: EventSource | null = null;

  constructor(apiKey = '', baseUrl = '') {
    this.client = createAuthClient(apiKey, baseUrl);
  }

  async createSession(): Promise<string> {
    if (!this.client.token) {
      await exchangeToken(this.client);
    }
    const res = await apiFetch(this.client, '/sessions', { method: 'POST' });
    if (!res.ok) throw new Error(`Create session failed: ${res.status}`);
    const data = await res.json();
    return data.sessionId;
  }

  async connect(sessionId: string): Promise<void> {
    this.disconnect();
    if (!this.client.token) {
      await exchangeToken(this.client);
    }
    const url = `${this.client.baseUrl}/sessions/${sessionId}/events?token=${this.client.token}`;
    this.eventSource = new EventSource(url);
    this.eventSource.onmessage = (e) => {
      try {
        const event: AgentEvent = JSON.parse(e.data);
        this.store.dispatch(event);
      } catch { /* ignore parse errors */ }
    };
    this.eventSource.addEventListener('user_question', (e) => {
      try {
        const event: AgentEvent = JSON.parse((e as MessageEvent).data);
        this.store.dispatch(event);
      } catch { /* ignore */ }
    });
    this.eventSource.onerror = () => {
      // Auto-reconnect is handled by EventSource
    };
  }

  async prompt(sessionId: string, message: string): Promise<void> {
    this.store.addUserMessage(message);
    const res = await apiFetch(this.client, `/sessions/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`Prompt failed: ${res.status}`);
  }

  async answer(sessionId: string, toolCallId: string, response: string): Promise<void> {
    const res = await apiFetch(this.client, `/sessions/${sessionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId, response }),
    });
    if (!res.ok) throw new Error(`Answer failed: ${res.status}`);
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }
}
