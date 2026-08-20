import { apiFetch, createAuthClient, type AuthClient } from '../bridge/auth';
import { CortxApiError } from './api-client';

export interface SseSubscription {
  close(): void;
  done: Promise<void>;
}

export interface SseHandlers {
  onOpen?(): void;
  onFrame(data: unknown): void;
  onDisconnect?(error?: unknown): void;
}

export class FetchSseTransport {
  readonly #auth: AuthClient;

  constructor(apiKey = '', baseUrl = '') {
    this.#auth = createAuthClient(apiKey, baseUrl);
  }

  connect(path: string, handlers: SseHandlers): SseSubscription {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const done = (async () => {
      try {
        const response = await apiFetch(this.#auth, path, {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
        });
        if (!response.ok) {
          throw new CortxApiError(`Event stream failed: ${response.status}`, response.status);
        }
        if (!response.body) throw new CortxApiError('Event stream response has no body', response.status);
        handlers.onOpen?.();
        reader = response.body.getReader();
        await pumpSse(reader, (data) => {
          try {
            handlers.onFrame(JSON.parse(data) as unknown);
          } catch {
            // One malformed frame cannot poison the transport.
          }
        }, controller.signal);
        if (!controller.signal.aborted) handlers.onDisconnect?.();
      } catch (error) {
        if (!controller.signal.aborted) handlers.onDisconnect?.(error);
      }
    })();
    return {
      close() {
        controller.abort(new Error('SSE subscription closed'));
        void reader?.cancel().catch(() => undefined);
      },
      done,
    };
  }
}

async function pumpSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onData: (data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const processLine = (line: string) => {
    if (!line) {
      if (dataLines.length) onData(dataLines.join('\n'));
      dataLines = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
  };

  while (!signal.aborted) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    while (true) {
      const match = buffer.match(/\r\n|\n|\r/);
      if (!match || match.index === undefined) break;
      processLine(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer) processLine(buffer);
  if (dataLines.length) onData(dataLines.join('\n'));
}
