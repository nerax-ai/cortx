import { describe, expect, mock, test } from 'bun:test';
import type { AgentEvent, LanguageMessage } from '@cortx/sdk';
import { createTuiHost } from '../tui-host.js';
import type { TuiSessionAdapter } from '../runtime-session.js';

function session(id: string, next?: TuiSessionAdapter) {
  const close = mock(async () => {});
  const value: TuiSessionAdapter = {
    mode: 'remote' as const,
    agentSessions: {} as TuiSessionAdapter['agentSessions'],
    supportsMessageRestore: false,
    getInfo: () => ({
      id,
      createdAt: 1,
      lastActivityAt: 1,
      workingDirectory: '/repo',
      model: 'test',
      toolMode: 'none' as const,
      toolProfile: '@cortx-ai/workspace-tools/none',
      approvalMode: 'interactive' as const,
      capabilities: { skills: true, subAgents: true, approval: true },
      isRunning: false,
      eventCount: 0,
    }),
    subscribe: (_listener: (event: AgentEvent) => void) => ({ close: async () => {} }),
    prompt: async () => {},
    listSessions: async () => [],
    switchSession: async () => next ?? value,
    createSessionForWorkspace: async () => next ?? value,
    listAgentSpecs: async () => [],
    launchAgentSpec: async () => next ?? value,
    listSkillPacks: async () => [],
    installSkillPack: async () => ({
      schemaVersion: 1,
      id: 'test',
      sourcePath: '/test',
      installedAt: 1,
      path: '/test',
      skillPaths: [],
      agentSpecPaths: [],
    }),
    createSession: async () => next ?? value,
    steer: async () => {},
    followUp: async () => {},
    resume: async () => {},
    answerUser: async () => {},
    abort: async () => {},
    getAgentMessages: (): LanguageMessage[] => [],
    replaceAgentMessages: () => {},
    close,
  };
  return { value, close };
}

describe('createTuiHost', () => {
  test('creates an isolated temporary plugin runtime domain per TUI instance', async () => {
    const firstSession = session('first');
    const secondSession = session('second');
    const first = await createTuiHost({ session: firstSession.value });
    const second = await createTuiHost({ session: secondSession.value });

    expect(first.runtimeDomainId).not.toBe(second.runtimeDomainId);
    expect(first.runtimeDomainId).toStartWith('cortx-tui:');
    expect(first.registry.getCommands().map((command) => command.name).sort()).toEqual([
      '/agent',
      '/agents',
      '/clear',
      '/config',
      '/exit',
      '/help',
      '/quit',
      '/resume',
      '/session',
      '/sessions',
      '/skill-pack',
      '/skill-packs',
      '/steer',
    ]);
    expect(first.registry.getRenderers()).toEqual([]);

    await first.close();
    await second.close();
  });

  test('switches the stable session authority without rebuilding the TUI host', async () => {
    const replacement = session('replacement');
    const initial = session('initial', replacement.value);
    const notices: string[] = [];
    const host = await createTuiHost({
      session: initial.value,
      actions: { showNotice: (message) => notices.push(message) },
    });
    const registry = host.registry;
    const commands = registry.getCommands();

    expect(await registry.executeCommand('/session', 'replacement', { args: 'replacement', abort: () => {} })).toBe(true);
    expect(host.sessions.current.getInfo().id).toBe('replacement');
    expect(host.registry).toBe(registry);
    expect(host.registry.getCommands()).toEqual(commands);
    expect(initial.close).toHaveBeenCalledTimes(1);
    expect(notices).toContain('Switched to session: replacement');

    await host.close();
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  test('awaits all owners and aggregates close failures', async () => {
    const broken = session('broken');
    broken.close.mockImplementation(async () => {
      throw new Error('session close failed');
    });
    const host = await createTuiHost({ session: broken.value });

    await expect(host.close()).rejects.toThrow('TUI Host close failed');
    expect(broken.close).toHaveBeenCalledTimes(1);
    await expect(host.close()).rejects.toThrow('TUI Host close failed');
  });
});
