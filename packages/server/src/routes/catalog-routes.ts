import type { Context, Hono } from 'hono';
import { readOptionalJson, respondJson } from '../http.js';

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
  app.get('/models', async (c) => respondJson(c, () => handlers.listModels(c)));
  app.post('/agent-specs/launch', async (c) =>
    respondJson(c, async () => handlers.launchAgentSpec(c, await readOptionalJson(c)), 201));
  app.get('/agent-specs', async (c) => respondJson(c, () => handlers.listAgentSpecs(c)));
  app.get('/tool-profiles', async (c) => respondJson(c, () => handlers.listToolProfiles(c)));
  app.get('/skill-packs', async (c) => respondJson(c, () => handlers.listSkillPacks(c)));
  app.post('/skill-packs/install', async (c) =>
    respondJson(c, async () => handlers.installSkillPack(c, await readOptionalJson(c)), 201));
  app.get('/workspaces/directories', async (c) => respondJson(c, () => handlers.listWorkspaceDirectories(c)));
}
