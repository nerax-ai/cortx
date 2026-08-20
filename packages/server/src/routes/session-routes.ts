import type { Context, Hono } from 'hono';
import {
  RuntimeError,
  type CortxRuntime,
  type RuntimeSessionCreateRequest,
  type RuntimeSessionInfo,
  type RuntimeSessionUpdateRequest,
} from '@cortx/runtime';
import {
  assertOptionalString,
  errorResponse,
  parseOptionalTimeout,
  readMessage,
  readOptionalJson,
  readRuntimeCommandOptions,
  requireString,
} from '../http.js';

export interface SessionRouteDependencies {
  runtime: CortxRuntime;
  authorizeSession(c: Context, sessionId: string): Promise<RuntimeSessionInfo>;
  listSessions(c: Context): Promise<RuntimeSessionInfo[]>;
  buildCreateRequest(c: Context, body: Record<string, unknown>): Promise<RuntimeSessionCreateRequest>;
  buildUpdateRequest(c: Context, body: Record<string, unknown>): Promise<RuntimeSessionUpdateRequest>;
  serializeSkill(skill: Awaited<ReturnType<CortxRuntime['listSessionSkills']>>[number]): unknown;
  serializeChild(child: ReturnType<CortxRuntime['getChildSession']>): unknown;
}

export const SESSION_ENDPOINT_POLICIES = [
  { method: 'POST', path: '/sessions', access: 'authenticated' },
  { method: 'GET', path: '/sessions', access: 'creator-or-admin' },
  { method: 'GET', path: '/sessions/:id', access: 'creator-or-admin' },
  { method: 'PATCH', path: '/sessions/:id', access: 'creator-or-admin' },
  { method: 'DELETE', path: '/sessions/:id', access: 'creator-or-admin' },
  { method: 'POST', path: '/sessions/:id/prompt', access: 'creator-or-admin' },
  { method: 'POST', path: '/sessions/:id/steer', access: 'creator-or-admin' },
  { method: 'POST', path: '/sessions/:id/follow-up', access: 'creator-or-admin' },
  { method: 'POST', path: '/sessions/:id/follow-up/:inputId/cancel', access: 'creator-or-admin' },
  { method: 'POST', path: '/sessions/:id/resume', access: 'creator-or-admin' },
  { method: 'POST', path: '/sessions/:id/abort', access: 'creator-or-admin' },
  { method: 'POST', path: '/sessions/:id/answer', access: 'creator-or-admin' },
] as const;

export function mountSessionRoutes(app: Hono, deps: SessionRouteDependencies): void {
  const { runtime } = deps;

  app.post('/sessions', async (c) => respond(c, async () => {
    const body = await readOptionalJson(c);
    const session = await runtime.createSession(await deps.buildCreateRequest(c, body));
    return { sessionId: session.id, session };
  }, 201));

  app.get('/sessions', async (c) => respond(c, async () => ({ sessions: await deps.listSessions(c) })));

  app.get('/sessions/:id', async (c) => respond(c, async () => ({
    session: await deps.authorizeSession(c, c.req.param('id')),
  })));

  app.patch('/sessions/:id', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const body = await readOptionalJson(c);
    const session = await runtime.updateSession(
      id,
      await deps.buildUpdateRequest(c, body),
      readRuntimeCommandOptions(c, body),
    );
    return { session };
  }));

  app.get('/sessions/:id/skills', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    return { skills: (await runtime.listSessionSkills(id)).map(deps.serializeSkill) };
  }));

  app.get('/sessions/:id/children', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    return { children: runtime.listChildSessions(id).map(deps.serializeChild) };
  }));

  app.get('/sessions/:id/children/:toolCallId', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    return { child: deps.serializeChild(runtime.getChildSession(id, c.req.param('toolCallId'))) };
  }));

  app.post('/sessions/:id/children/:toolCallId/abort', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const body = await readOptionalJson(c);
    const reason = assertOptionalString(body.reason, 'reason') ?? 'Child aborted via Server';
    return { child: deps.serializeChild(await runtime.abortChild(id, c.req.param('toolCallId'), reason)) };
  }));

  app.get('/sessions/:id/children/:toolCallId/wait', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const child = await runtime.waitForChild(
      id,
      c.req.param('toolCallId'),
      parseOptionalTimeout(c.req.query('timeoutMs')),
    );
    return { child: deps.serializeChild(child) };
  }));

  app.post('/sessions/:id/prompt', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const body = await readOptionalJson(c);
    await runtime.prompt(id, readMessage(body), readRuntimeCommandOptions(c, body));
    return { ok: true, session: runtime.getSession(id) };
  }));

  app.post('/sessions/:id/steer', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const body = await readOptionalJson(c);
    await runtime.steer(id, readMessage(body), readRuntimeCommandOptions(c, body));
    return { ok: true, session: runtime.getSession(id) };
  }));

  app.post('/sessions/:id/follow-up', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const body = await readOptionalJson(c);
    const inputId = typeof body.inputId === 'string' && body.inputId.trim()
      ? body.inputId
      : typeof body.commandId === 'string' && body.commandId.trim()
        ? body.commandId
        : crypto.randomUUID();
    const admission = await runtime.followUp(
      id,
      readMessage(body),
      inputId,
      readRuntimeCommandOptions(c, body),
    );
    return { ok: true, admission, session: runtime.getSession(id) };
  }));

  app.post('/sessions/:id/follow-up/:inputId/cancel', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const body = await readOptionalJson(c);
    const cancelled = await runtime.cancelFollowUp(
      id,
      c.req.param('inputId'),
      readRuntimeCommandOptions(c, body),
    );
    if (!cancelled) {
      throw new RuntimeError('conflict', 'Follow-up is no longer cancellable', {
        inputId: c.req.param('inputId'),
      });
    }
    return { ok: true, session: runtime.getSession(id) };
  }));

  app.post('/sessions/:id/resume', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const body = await readOptionalJson(c);
    await runtime.resume(id, readRuntimeCommandOptions(c, body));
    return { ok: true, session: runtime.getSession(id) };
  }));

  app.post('/sessions/:id/abort', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const body = await readOptionalJson(c);
    await runtime.abort(id, readRuntimeCommandOptions(c, body));
    return { ok: true, session: runtime.getSession(id) };
  }));

  app.post('/sessions/:id/answer', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    const body = await readOptionalJson(c);
    const toolCallId = requireString(body.toolCallId, 'toolCallId');
    const response = requireString(body.response, 'response');
    const answered = await runtime.answer(id, toolCallId, response, readRuntimeCommandOptions(c, body));
    if (!answered) {
      throw new RuntimeError('conflict', 'No current pending interaction matches toolCallId', { toolCallId });
    }
    return { ok: true, session: runtime.getSession(id) };
  }));

  app.delete('/sessions/:id', async (c) => respond(c, async () => {
    const id = c.req.param('id');
    await deps.authorizeSession(c, id);
    await runtime.deleteSession(id);
    return { ok: true };
  }));
}

async function respond(
  c: Context,
  handler: () => unknown | Promise<unknown>,
  status: 200 | 201 = 200,
): Promise<Response> {
  try {
    return c.json(await handler(), status);
  } catch (error) {
    const response = errorResponse(error);
    return c.json(response.body, response.status);
  }
}
