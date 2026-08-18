import {
  MemoryPluginSecretsBackend,
  createMemoryPluginRuntimeDomain,
  definePluginContract,
  type JsonObject,
} from '@nerax-ai/plugin';
import {
  AGENT_TOOL,
  RUNTIME_TOOL_PROFILE,
  defineContributionBinding,
  defineCortxContributionDescriptor,
  type Tool,
} from '@cortx/sdk';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ProjectDomain } from '../../src/project-domain.js';

const PLUGIN_ID = '@cortx-ai/workspace-tools';
const TOOL_IDS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

export async function createWorkspaceToolProjectDomain(
  extraProfiles: Array<{ id: string; tools: Array<string | { use: string; options?: JsonObject }> }> = [],
): Promise<ProjectDomain> {
  const root = mkdtempSync(join(tmpdir(), 'cortx-runtime-project-domain-'));
  const project = new ProjectDomain({
    domain: createMemoryPluginRuntimeDomain({
      runtimeDomainId: `test:${crypto.randomUUID()}`,
      root,
      secretsBackend: new MemoryPluginSecretsBackend('cortx-runtime-test'),
    }),
  });
  await project.register(
    definePluginContract({
      manifest: {
        manifestVersion: 1,
        id: PLUGIN_ID,
        name: 'Workspace tools test fixture',
        version: '1.0.0',
        runtime: { main: 'inline' },
        contributes: {
          [AGENT_TOOL]: TOOL_IDS.map((id) =>
            defineCortxContributionDescriptor({ id, displayName: id, executable: true }),
          ),
          [RUNTIME_TOOL_PROFILE]: [
            profile('none', []),
            profile('read-only', ['read', 'grep', 'find', 'ls']),
            profile('coding', ['read', 'bash', 'edit', 'write']),
            profile('all', [...TOOL_IDS]),
            ...extraProfiles.map((item) =>
              defineCortxContributionDescriptor({
                id: item.id,
                displayName: item.id,
                executable: false,
                defaultOptions: { tools: item.tools },
              }),
            ),
          ],
        },
      },
      setup(ctx) {
        for (const id of TOOL_IDS) {
          ctx.bind(defineContributionBinding(AGENT_TOOL, id, (options) => createTool(id, options)));
        }
      },
    }),
  );
  return project;
}

function profile(id: string, tools: readonly string[]) {
  return defineCortxContributionDescriptor({
    id,
    displayName: id,
    executable: false,
    defaultOptions: { tools: tools.map((tool) => `${PLUGIN_ID}/${tool}`) },
  });
}

function createTool(name: (typeof TOOL_IDS)[number], options: JsonObject): Tool {
  const workingDirectory = typeof options.workingDirectory === 'string' ? options.workingDirectory : process.cwd();
  return {
    name,
    description: `${name} test tool`,
    sideEffects: name === 'read' || name === 'grep' || name === 'find' || name === 'ls' ? 'read' : 'write',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    async execute(input) {
      if (name === 'read') {
        const path = withinWorkspace(workingDirectory, String(input.path ?? ''));
        return { success: true, output: readFileSync(path, 'utf8') };
      }
      if (name === 'write') {
        const path = withinWorkspace(workingDirectory, String(input.path ?? ''));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(input.content ?? ''), 'utf8');
        return { success: true, output: path };
      }
      return { success: true, output: `${name}:ok` };
    },
  };
}

function withinWorkspace(workingDirectory: string, requested: string): string {
  const root = resolve(workingDirectory);
  const target = resolve(root, requested);
  const child = relative(root, target);
  if (isAbsolute(child) || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }
  return target;
}
