import { describe, expect, test } from 'bun:test';
import { RemoteRuntimeClient } from '../remote-client.js';

function sseResponse(chunks: string[], onCancel?: () => void, keepOpen = false): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!keepOpen) controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('RemoteRuntimeClient header-authenticated SSE', () => {
  test('streams envelopes with Authorization headers and no URL credential', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const events: string[] = [];
    const client = new RemoteRuntimeClient({
      baseUrl: 'https://cortx.example.test',
      apiKey: 'secret-key',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return sseResponse([
          ': heartbeat\n\n',
          'data: {"sequence":1,"timestamp":1,"sessionId":"sess","runId":1,"event":{"type":"text_delta","delta":"hello"}}\n\n',
          'data: {"sequence":1,"timestamp":2,"sessionId":"sess","runId":1,"event":{"type":"text_delta","delta":"duplicate"}}\n\n',
          'data: {"sequence":2,"timestamp":3,"sessionId":"sess","runId":1,"event":{"type":"done"}}\n\n',
        ]);
      },
    });

    const subscription = await client.connectEvents('sess', (event) => events.push(event.type));
    await subscription.closed;

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://cortx.example.test/sessions/sess/events?format=envelope');
    expect(calls[0].url).not.toContain('secret-key');
    expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer secret-key');
    expect(events).toEqual(['text_delta', 'done']);

    await subscription.close();
    await client.close();
  });

  test('close aborts and awaits an open stream', async () => {
    let cancelled = false;
    const client = new RemoteRuntimeClient({
      baseUrl: 'https://cortx.example.test',
      apiKey: 'secret-key',
      fetch: async () => sseResponse([': waiting\n\n'], () => { cancelled = true; }, true),
    });

    const subscription = await client.connectEvents('sess', () => {});
    await subscription.close();

    expect(cancelled).toBe(true);
    await expect(subscription.closed).resolves.toBeUndefined();
  });

  test('rejects credentials embedded in the server URL', () => {
    expect(() => new RemoteRuntimeClient({
      baseUrl: 'https://user:password@cortx.example.test',
      apiKey: 'secret-key',
    })).toThrow('must not contain credentials');
  });
});
