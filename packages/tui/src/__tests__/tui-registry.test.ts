import { describe, expect, mock, test } from 'bun:test';
import { TuiRegistry } from '../tui-registry.js';
import {
  TUI_COMMAND,
  TUI_RENDERER,
  defineTuiContributionBinding,
  defineTuiContributionDescriptor,
  type CommandDef,
  type RendererDef,
  type TuiPlugin,
  type TuiPluginContext,
} from '../types/tui-plugin.js';

function commandPlugin(id: string, command: CommandDef): TuiPlugin {
  return {
    manifest: {
      manifestVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      runtime: { main: 'inline' },
      contributes: {
        [TUI_COMMAND]: [defineTuiContributionDescriptor({
          id: 'command',
          displayName: command.name,
          description: command.description,
          executable: true,
        })],
      },
    },
    setup(ctx: TuiPluginContext) {
      ctx.bind(defineTuiContributionBinding(TUI_COMMAND, 'command', () => command));
    },
  };
}

function rendererPlugin(id: string, renderer: RendererDef): TuiPlugin {
  return {
    manifest: {
      manifestVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      runtime: { main: 'inline' },
      contributes: {
        [TUI_RENDERER]: [defineTuiContributionDescriptor({
          id: 'renderer',
          displayName: renderer.eventType,
          executable: true,
        })],
      },
    },
    setup(ctx: TuiPluginContext) {
      ctx.bind(defineTuiContributionBinding(TUI_RENDERER, 'renderer', () => renderer));
    },
  };
}

describe('TuiRegistry declarative runtime', () => {
  test('activates commands through Manifest descriptors and ctx.bind', async () => {
    const handler = mock(async () => {});
    const registry = new TuiRegistry();
    await registry.registerPlugin(commandPlugin('test-command', {
      name: '/test',
      description: 'test command',
      handler,
    }));

    expect(registry.getCommands().map((command) => command.name)).toEqual(['/test']);
    expect(await registry.executeCommand('/test', 'value', { args: 'value', abort() {} })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  test('filters renderer snapshots by event type', async () => {
    const registry = new TuiRegistry();
    await registry.registerPlugin(rendererPlugin('text-renderer', { eventType: 'text_delta', render: () => undefined }));
    await registry.registerPlugin(rendererPlugin('tool-renderer', { eventType: 'tool_use', render: () => undefined }));

    expect(registry.getRenderers()).toHaveLength(2);
    expect(registry.getRenderers('text_delta')).toHaveLength(1);
    await registry.close();
  });

  test('rejects dormant contribution types before plugin setup', async () => {
    const registry = new TuiRegistry();
    await expect(registry.registerPlugin({
      manifest: {
        manifestVersion: 1,
        id: 'unsupported',
        name: 'unsupported',
        version: '1.0.0',
        runtime: { main: 'inline' },
        contributes: { 'tui.region': [{ id: 'output', executable: true }] },
      },
      setup() {},
    })).rejects.toThrow('Unsupported TUI contribution type: tui.region');
    await registry.close();
  });

  test('keeps the active snapshot when a new plugin setup fails', async () => {
    const registry = new TuiRegistry();
    await registry.registerPlugin(commandPlugin('stable', { name: '/stable', description: 'stable', handler() {} }));
    const snapshot = registry.getCommands();

    await expect(registry.registerPlugin({
      manifest: {
        manifestVersion: 1,
        id: 'broken',
        name: 'broken',
        version: '1.0.0',
        runtime: { main: 'inline' },
        contributes: { [TUI_COMMAND]: [{ id: 'broken', executable: true }] },
      },
      setup() { throw new Error('setup exploded'); },
    })).rejects.toThrow();

    expect(registry.getCommands()).toBe(snapshot);
    expect(registry.getCommands().map((command) => command.name)).toEqual(['/stable']);
    await registry.close();
  });

  test('captures command handler failures without taking down the TUI', async () => {
    const registry = new TuiRegistry();
    await registry.registerPlugin(commandPlugin('broken-handler', {
      name: '/boom',
      description: 'boom',
      handler() { throw new Error('kaboom'); },
    }));

    expect(await registry.executeCommand('/boom', '', { args: '', abort() {} })).toBe(true);
    expect(registry.getErrors().at(-1)?.error.message).toBe('kaboom');
    await registry.close();
  });
});
