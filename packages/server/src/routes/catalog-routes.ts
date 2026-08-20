import type { Context, Hono } from 'hono';
import { errorResponse, readOptionalJson } from '../http.js';

export interface CatalogRouteHandlers {
  listModels(c: Context): unknown | Promise<unknown>;
  launchAgentSpec(c: Context, body: Record<string, unknown>): unknown | Promise<unknown>;
  listAgentSpecs(c: Context): unknown | Promise<unknown>;
  listToolProfiles(c: Context): unknown | Promise<unknown>;
  listSkillPacks(c: Context): unknown | Promise<unknown>;
  installSkillPack(c: Context, body: Record<string, unknown>): unknown | Promise<unknown>;
  listWorkspaceDirectories(c: Context): unknown | Promise<unknown>;
}

export function mountCatalogRoutes(app: Hono, handlers: CatalogRouteHandlers): void {
  app.get('/models', async (c) => respond(c, () => handlers.listModels(c)));
  app.post('/agent-specs/launch', async (c) =>
    respond(c, async () => handlers.launchAgentSpec(c, await readOptionalJson(c)), 201));
  app.get('/agent-specs', async (c) => respond(c, () => handlers.listAgentSpecs(c)));
  app.get('/tool-profiles', async (c) => respond(c, () => handlers.listToolProfiles(c)));
  app.get('/skill-packs', async (c) => respond(c, () => handlers.listSkillPacks(c)));
  app.post('/skill-packs/install', async (c) =>
    respond(c, async () => handlers.installSkillPack(c, await readOptionalJson(c)), 201));
  app.get('/workspaces/directories', async (c) => respond(c, () => handlers.listWorkspaceDirectories(c)));
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
