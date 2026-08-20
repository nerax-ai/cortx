export type RuntimeErrorKind =
  | 'invalid_workspace'
  | 'permission_denied'
  | 'session_not_found'
  | 'session_busy'
  | 'conflict'
  | 'capacity_exceeded'
  | 'invalid_request'
  | 'runtime_failure';

const STATUS_BY_KIND: Record<RuntimeErrorKind, number> = {
  invalid_workspace: 400,
  permission_denied: 403,
  session_not_found: 404,
  session_busy: 409,
  conflict: 409,
  capacity_exceeded: 429,
  invalid_request: 400,
  runtime_failure: 500,
};

export class RuntimeError extends Error {
  readonly kind: RuntimeErrorKind;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(kind: RuntimeErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RuntimeError';
    this.kind = kind;
    this.status = STATUS_BY_KIND[kind];
    this.details = details;
  }
}

export function isRuntimeError(error: unknown): error is RuntimeError {
  return error instanceof RuntimeError;
}

export function toRuntimeError(error: unknown): RuntimeError {
  if (isRuntimeError(error)) return error;
  if (error instanceof Error) return new RuntimeError('runtime_failure', error.message);
  return new RuntimeError('runtime_failure', String(error));
}
