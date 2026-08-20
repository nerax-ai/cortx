import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  isRuntimeError,
  RuntimeError,
  type RuntimeCommandOptions,
} from '@cortx/runtime';

export function parseOptionalSequence(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RuntimeError('invalid_request', `${name} must be a non-negative integer`);
  }
  return parsed;
}

export function parseOptionalLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RuntimeError('invalid_request', 'limit must be a positive integer');
  }
  return Math.min(parsed, 2_000);
}

export function parseOptionalTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 60_000) {
    throw new RuntimeError('invalid_request', 'timeoutMs must be an integer between 1 and 60000');
  }
  return parsed;
}

export function errorResponse(error: unknown): {
  body: { error: string; kind?: string; details?: Record<string, unknown> };
  status: ContentfulStatusCode;
} {
  if (isRuntimeError(error)) {
    return {
      body: { error: error.message, kind: error.kind, details: error.details },
      status: error.status as ContentfulStatusCode,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { body: { error: message }, status: 500 as ContentfulStatusCode };
}

export async function readOptionalJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    throw new RuntimeError('invalid_request', 'JSON body must be an object');
  } catch (error) {
    if (isRuntimeError(error)) throw error;
    throw new RuntimeError('invalid_request', 'Invalid JSON body');
  }
}

export function readMessage(body: Record<string, unknown>): string {
  if (body.message === undefined) return '';
  if (typeof body.message !== 'string') throw new RuntimeError('invalid_request', 'message must be a string');
  return body.message;
}

export function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RuntimeError('invalid_request', `${field} must be a string`);
  return value;
}

/**
 * Mutations accept command metadata in JSON for browser clients and in headers
 * for methods without a body. The Runtime remains the idempotency authority.
 */
export function readRuntimeCommandOptions(
  c: Context,
  body: Record<string, unknown> = {},
): RuntimeCommandOptions {
  const commandId = assertOptionalString(body.commandId, 'commandId') ?? c.req.header('Idempotency-Key');
  const expectedRuntimeIncarnation =
    assertOptionalString(body.expectedRuntimeIncarnation, 'expectedRuntimeIncarnation') ??
    c.req.header('If-Runtime-Incarnation');
  return {
    ...(commandId ? { commandId } : {}),
    ...(expectedRuntimeIncarnation ? { expectedRuntimeIncarnation } : {}),
  };
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuntimeError('invalid_request', `${field} must be a non-empty string`);
  }
  return value;
}
