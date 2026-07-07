import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, LanguageMessage } from '@cortx/sdk';
import {
  AGENT_SPEC_SCHEMA_VERSION,
  CortxRuntime,
  discoverAgentSpecs,
  installSkillPack,
  loadAgentSpecFile,
  parseAgentSpec,
} from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-agent-spec-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function capturingLanguage(captured: { messages?: LanguageMessage[]; tools?: unknown[] }): LanguageClient {
  return {
    stream: async function* (request: { messages: LanguageMessage[]; tools?: unknown[] }) {
      captured.messages = request.messages;
      captured.tools = request.tools;
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      };
    },
  } as unknown as LanguageClient;
}

function neverFinishingLanguage(captured: { messages?: LanguageMessage[]; tools?: unknown[] }): LanguageClient {
  return {
    stream: async function* (request: { messages: LanguageMessage[]; tools?: unknown[] }) {
      captured.messages = request.messages;
      captured.tools = request.tools;
      await new Promise(() => {});
    },
  } as unknown as LanguageClient;
}

function textOf(message: LanguageMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return content?.find((part) => part.type === 'text')?.text ?? '';
}

describe('AgentSpec asset launch', () => {
  test('validates prompt-only specs', () => {
    expect(parseAgentSpec({ prompt: 'hello' })).toMatchObject({
      schemaVersion: AGENT_SPEC_SCHEMA_VERSION,
      prompt: 'hello',
    });
    expect(parseAgentSpec({ schemaVersion: 0, prompt: 'legacy hello' })).toMatchObject({
      schemaVersion: AGENT_SPEC_SCHEMA_VERSION,
      prompt: 'legacy hello',
    });
    expect(parseAgentSpec({ schemaVersion: AGENT_SPEC_SCHEMA_VERSION, prompt: 'hello' })).toMatchObject({
      schemaVersion: AGENT_SPEC_SCHEMA_VERSION,
      prompt: 'hello',
    });
    expect(() => parseAgentSpec({ schemaVersion: 999, prompt: 'hello' })).toThrow('AgentSpec.schemaVersion');
    expect(() => parseAgentSpec({ prompt: '' })).toThrow('AgentSpec.prompt');
    expect(() => parseAgentSpec({ prompt: 'ok', skillPaths: [1] })).toThrow('AgentSpec.skillPaths');
    expect(parseAgentSpec({ prompt: 'ok', toolMode: 'everything' }).toolMode).toBe('everything');
    expect(() => parseAgentSpec({ prompt: 'ok', approvalMode: 'ask' })).toThrow('AgentSpec.approvalMode');
    expect(parseAgentSpec({ prompt: 'ok', approvalMode: 'full-access' }).approvalMode).toBe('full-access');
    expect(() => parseAgentSpec({ prompt: 'ok', capabilities: { skills: 'yes' } })).toThrow(
      'AgentSpec.capabilities',
    );
  });

  test('launches a prompt-only agent without product defaults', async () => {
    const captured: { messages?: LanguageMessage[]; tools?: unknown[] } = {};
    const runtime = new CortxRuntime({
      language: capturingLanguage(captured),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'all',
    });
    const session = await runtime.launchAgentSpec({
      prompt: 'small agent task',
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));
    await waitForEvent(events, 'done');

    expect(textOf(captured.messages?.at(-1))).toBe('small agent task');
    expect(captured.tools ?? []).toEqual([]);
    runtime.dispose();
  });

  test('returns current session info after launching the AgentSpec prompt', async () => {
    const captured: { messages?: LanguageMessage[]; tools?: unknown[] } = {};
    const runtime = new CortxRuntime({
      language: neverFinishingLanguage(captured),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'all',
    });

    const session = await runtime.launchAgentSpec({
      prompt: 'long running task',
      toolMode: 'none',
      capabilities: { skills: false, subAgents: false, approval: false },
    });

    expect(session.isRunning).toBe(true);
    expect(runtime.getSession(session.id).isRunning).toBe(true);
    runtime.dispose();
  });

  test('loads and launches an AgentSpec JSON file', async () => {
    const specPath = join(tmpDir, 'agent.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        schemaVersion: AGENT_SPEC_SCHEMA_VERSION,
        name: 'file-agent',
        prompt: 'file task',
        toolMode: 'none',
        capabilities: { skills: false, subAgents: false, approval: false },
      }),
      'utf8',
    );
    const loaded = await loadAgentSpecFile(specPath);
    expect(loaded).toMatchObject({ name: 'file-agent', prompt: 'file task' });

    const captured: { messages?: LanguageMessage[]; tools?: unknown[] } = {};
    const runtime = new CortxRuntime({
      language: capturingLanguage(captured),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'all',
    });
    const session = await runtime.launchAgentSpecFile(specPath);
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));
    await waitForEvent(events, 'done');

    expect(session.metadata).toMatchObject({ agentSpec: 'file-agent' });
    expect(textOf(captured.messages?.at(-1))).toBe('file task');
    expect(captured.tools ?? []).toEqual([]);
    runtime.dispose();
  });

  test('loads legacy AgentSpec JSON files as current schema', async () => {
    const specPath = join(tmpDir, 'legacy-agent.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        schemaVersion: 0,
        name: 'legacy-agent',
        prompt: 'legacy task',
        toolMode: 'read-only',
        approvalMode: 'deny',
        skillPacks: ['legacy-pack'],
      }),
      'utf8',
    );

    const loaded = await loadAgentSpecFile(specPath);

    expect(loaded).toMatchObject({
      schemaVersion: AGENT_SPEC_SCHEMA_VERSION,
      name: 'legacy-agent',
      prompt: 'legacy task',
      toolMode: 'read-only',
      approvalMode: 'deny',
      skillPacks: ['legacy-pack'],
    });
  });

  test('discovers AgentSpec JSON files from agents directories', async () => {
    const agentsDir = join(tmpDir, 'packs', 'review', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'reviewer.json'),
      JSON.stringify({
        name: 'reviewer',
        prompt: 'Review the current diff and report correctness findings.',
        workingDirectory: tmpDir,
        toolMode: 'read-only',
        approvalMode: 'deny',
        metadata: { source: 'test' },
      }),
      'utf8',
    );
    writeFileSync(join(agentsDir, 'README.md'), 'ignored', 'utf8');

    const specs = await discoverAgentSpecs({ roots: [tmpDir] });

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      schemaVersion: AGENT_SPEC_SCHEMA_VERSION,
      name: 'reviewer',
      workingDirectory: tmpDir,
      toolMode: 'read-only',
      approvalMode: 'deny',
      metadata: { source: 'test' },
    });
    expect(specs[0].path).toBe(join(agentsDir, 'reviewer.json'));
    expect(specs[0].relativePath).toBe('packs/review/agents/reviewer.json');
    expect(specs[0].promptPreview).toContain('Review the current diff');
  });

  test('discovers AgentSpecs from installed SkillPacks', async () => {
    const packDir = join(tmpDir, 'installed-pack');
    const agentsDir = join(packDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(packDir, 'skill-pack.json'), JSON.stringify({ name: 'installed-agents' }), 'utf8');
    writeFileSync(
      join(agentsDir, 'builder.json'),
      JSON.stringify({
        name: 'builder',
        prompt: 'Build the requested change.',
        toolMode: 'coding',
        approvalMode: 'interactive',
      }),
      'utf8',
    );
    const registryPath = join(tmpDir, 'registry.json');
    await installSkillPack({ registryPath, sourcePath: packDir });

    const specs = await discoverAgentSpecs({ installedSkillPackRegistryPath: registryPath });

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      name: 'builder',
      relativePath: 'agents/builder.json',
      sourceRoot: packDir,
      toolMode: 'coding',
      approvalMode: 'interactive',
    });
  });

  test('launches an AgentSpec that references an installed SkillPack id', async () => {
    const packDir = join(tmpDir, 'installed-skill-pack');
    const skillDir = join(packDir, 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(packDir, 'skill-pack.json'), JSON.stringify({ name: 'review-pack' }), 'utf8');
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: review\ndescription: Review changes\n---\nInstalled AgentSpec skill: $ARGUMENTS',
    );
    const registryPath = join(tmpDir, 'registry.json');
    await installSkillPack({ registryPath, sourcePath: packDir });

    const captured: { messages?: LanguageMessage[]; tools?: unknown[] } = {};
    const runtime = new CortxRuntime({
      language: capturingLanguage(captured),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
      skillPackRegistryPath: registryPath,
    });
    const session = await runtime.launchAgentSpec({
      name: 'installed-reviewer',
      prompt: '/review code',
      capabilities: { skills: true, subAgents: false, approval: false },
      skillPacks: ['review-pack'],
    });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));
    await waitForEvent(events, 'done');

    expect(session.skillPacks).toEqual(['review-pack']);
    expect(textOf(captured.messages?.at(-1))).toContain('Installed AgentSpec skill: code');
    runtime.dispose();
  });

  test('skips invalid specs by default and throws in strict discovery mode', async () => {
    const agentsDir = join(tmpDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'invalid.json'), JSON.stringify({ prompt: '' }), 'utf8');

    await expect(discoverAgentSpecs({ roots: [tmpDir] })).resolves.toEqual([]);
    await expect(discoverAgentSpecs({ roots: [tmpDir], strict: true })).rejects.toThrow('Invalid AgentSpec');
  });

  test('reports unsupported AgentSpec schema versions in strict discovery mode', async () => {
    const agentsDir = join(tmpDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'future.json'), JSON.stringify({ schemaVersion: 999, prompt: 'future' }), 'utf8');

    await expect(discoverAgentSpecs({ roots: [tmpDir] })).resolves.toEqual([]);
    await expect(discoverAgentSpecs({ roots: [tmpDir], strict: true })).rejects.toThrow('AgentSpec.schemaVersion');
  });
});

async function waitForEvent(events: AgentEvent[], type: AgentEvent['type'], timeoutMs = 1_000): Promise<AgentEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = events.find((item) => item.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}
