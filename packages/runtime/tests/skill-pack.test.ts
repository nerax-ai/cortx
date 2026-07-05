import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LanguageClient } from '@synax-ai/core';
import type { AgentEvent, LanguageMessage } from '@cortx/sdk';
import {
  CortxRuntime,
  SKILL_PACK_MANIFEST_SCHEMA_VERSION,
  parseSkillPackManifest,
  resolveSkillPack,
} from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortx-skill-pack-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function capturingLanguage(captured: { messages?: LanguageMessage[] }): LanguageClient {
  return {
    stream: async function* (request: { messages: LanguageMessage[] }) {
      captured.messages = request.messages;
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      };
    },
  } as unknown as LanguageClient;
}

function textOf(message: LanguageMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return content?.find((part) => part.type === 'text')?.text ?? '';
}

describe('skill pack assets', () => {
  test('validates SkillPack manifests', () => {
    expect(parseSkillPackManifest({ name: 'basic' })).toMatchObject({
      schemaVersion: SKILL_PACK_MANIFEST_SCHEMA_VERSION,
      name: 'basic',
    });
    expect(
      parseSkillPackManifest({
        schemaVersion: SKILL_PACK_MANIFEST_SCHEMA_VERSION,
        name: 'basic',
        skillPaths: ['skills'],
        agentSpecPaths: ['agents'],
        metadata: { category: 'engineering' },
      }),
    ).toMatchObject({
      schemaVersion: SKILL_PACK_MANIFEST_SCHEMA_VERSION,
      skillPaths: ['skills'],
      agentSpecPaths: ['agents'],
      metadata: { category: 'engineering' },
    });
    expect(() => parseSkillPackManifest({ schemaVersion: 999 })).toThrow('SkillPack.schemaVersion');
    expect(() => parseSkillPackManifest({ name: 1 })).toThrow('SkillPack.name');
    expect(() => parseSkillPackManifest({ skillPaths: [1] })).toThrow('SkillPack.skillPaths');
    expect(() => parseSkillPackManifest({ metadata: [] })).toThrow('SkillPack.metadata');
  });

  test('resolves pack metadata from a top-level manifest', async () => {
    const packDir = join(tmpDir, 'manifest-pack');
    const skillsDir = join(packDir, 'assets', 'skills');
    const agentsDir = join(packDir, 'assets', 'agents');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(packDir, 'skill-pack.json'),
      JSON.stringify({
        schemaVersion: SKILL_PACK_MANIFEST_SCHEMA_VERSION,
        name: 'manifest-pack',
        version: '0.1.0',
        description: 'Manifest backed pack',
        skillPaths: ['assets/skills'],
        agentSpecPaths: ['assets/agents'],
        metadata: { official: true },
      }),
      'utf8',
    );

    const pack = await resolveSkillPack(packDir);

    expect(pack).toMatchObject({
      schemaVersion: SKILL_PACK_MANIFEST_SCHEMA_VERSION,
      name: 'manifest-pack',
      version: '0.1.0',
      description: 'Manifest backed pack',
      metadata: { official: true },
    });
    expect(pack.manifestPath).toBe(join(packDir, 'skill-pack.json'));
    expect(pack.skillPaths).toEqual([skillsDir]);
    expect(pack.agentSpecPaths).toEqual([agentsDir]);
  });

  test('resolves hidden manifests and falls back to conventional asset paths', async () => {
    const packDir = join(tmpDir, 'hidden-pack');
    const skillsDir = join(packDir, 'skills');
    const agentsDir = join(packDir, 'agents');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(join(packDir, '.cortx'), { recursive: true });
    writeFileSync(join(packDir, '.cortx', 'skill-pack.json'), JSON.stringify({ name: 'hidden-pack' }), 'utf8');

    const pack = await resolveSkillPack(packDir);

    expect(pack.manifestPath).toBe(join(packDir, '.cortx', 'skill-pack.json'));
    expect(pack.name).toBe('hidden-pack');
    expect(pack.skillPaths).toEqual([skillsDir]);
    expect(pack.agentSpecPaths).toEqual([agentsDir]);
  });

  test('rejects manifest asset paths that escape the pack root', async () => {
    const packDir = join(tmpDir, 'escape-pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'skill-pack.json'),
      JSON.stringify({ skillPaths: ['../outside'], agentSpecPaths: [] }),
      'utf8',
    );

    await expect(resolveSkillPack(packDir)).rejects.toThrow('SkillPack.skillPaths');
  });

  test('allows manifest asset paths to point at the pack root', async () => {
    const packDir = join(tmpDir, 'root-pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, 'skill-pack.json'), JSON.stringify({ skillPaths: ['.'], agentSpecPaths: [] }), 'utf8');

    const pack = await resolveSkillPack(packDir);

    expect(pack.skillPaths).toEqual([packDir]);
  });

  test('rejects unsupported SkillPack manifest versions', async () => {
    const packDir = join(tmpDir, 'future-pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, 'skill-pack.json'), JSON.stringify({ schemaVersion: 999 }), 'utf8');

    await expect(resolveSkillPack(packDir)).rejects.toThrow('SkillPack.schemaVersion');
  });

  test('resolves skills and launches a skill-backed AgentSpec without core changes', async () => {
    const packDir = join(tmpDir, 'pack');
    const skillDir = join(packDir, 'skills', 'commit');
    const agentsDir = join(packDir, 'agents');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: commit\ndescription: Commit changes\n---\nExpanded pack skill: $ARGUMENTS',
    );
    writeFileSync(
      join(packDir, 'skill-pack.json'),
      JSON.stringify({
        schemaVersion: SKILL_PACK_MANIFEST_SCHEMA_VERSION,
        name: 'commit-pack',
        skillPaths: ['skills'],
        agentSpecPaths: ['agents'],
      }),
      'utf8',
    );
    writeFileSync(
      join(agentsDir, 'commit-agent.json'),
      JSON.stringify({ schemaVersion: 1, prompt: '/commit changes' }),
      'utf8',
    );

    const pack = await resolveSkillPack(packDir);
    expect(pack.name).toBe('commit-pack');
    expect(pack.skillPaths).toEqual([join(packDir, 'skills')]);
    expect(pack.agentSpecPaths).toEqual([agentsDir]);

    const captured: { messages?: LanguageMessage[] } = {};
    const runtime = new CortxRuntime({
      language: capturingLanguage(captured),
      model: 'test',
      defaultWorkingDirectory: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      toolMode: 'none',
    });
    const session = await runtime.launchAgentSpec({
      prompt: '/commit fix bug',
      capabilities: { skills: true, subAgents: false, approval: false },
      skillPacks: [packDir],
    });
    const events: AgentEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));
    await waitForEvent(events, 'done');

    expect(textOf(captured.messages?.at(-1))).toContain('Expanded pack skill: fix bug');
    runtime.dispose();
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
