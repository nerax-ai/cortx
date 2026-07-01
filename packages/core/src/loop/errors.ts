import type { AgentEvent, ErrorCode } from '@cortx/sdk';

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function classifyAgentError(error: unknown): ErrorCode {
  const err = toError(error);
  const msg = err.message.toLowerCase();
  const code = (err as { code?: string })?.code;
  const name = err.name.toLowerCase();
  const status =
    (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { statusCode?: number; status?: number })?.status ??
    0;
  if (code === 'timeout') return 'timeout';
  if (code === 'user_abort' || name === 'aborterror' || msg.includes('aborted')) return 'user_abort';
  if (
    status === 413 ||
    msg.includes('context length') ||
    msg.includes('context window') ||
    msg.includes('prompt is too long') ||
    msg.includes('too many tokens')
  )
    return 'context_overflow';
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) return 'rate_limited';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500 || msg.includes('503') || msg.includes('500') || msg.includes('server error'))
    return 'stream_error';
  return 'stream_error';
}

export function normalizeAgentError(error: unknown, code?: ErrorCode): AgentEvent & { type: 'error' } {
  const err = toError(error);
  return { type: 'error', error: err, code: code ?? classifyAgentError(err) };
}

export function userAbortError(reason?: string): Error & { code: 'user_abort' } {
  return Object.assign(new Error(reason ?? 'aborted'), { code: 'user_abort' as const });
}
