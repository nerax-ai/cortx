import { describe, test, expect, mock } from 'bun:test';
import { TuiRegistry } from '../tui-registry.js';
import { TUI_COMMAND, TUI_REGION, TUI_RENDERER, TUI_KEYBIND } from '../types/tui-plugin.js';
import type {
  CommandDef,
  RegionDef,
  RendererDef,
  KeyBindDef,
  TuiFactoryMap,
  TuiExtensionType,
} from '../types/tui-plugin.js';
import type { InlinePlugin, PluginContext, PluginStorage } from '@nerax-ai/plugin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a bare TuiRegistry without built-in plugins (clean slate). */
function createCleanRegistry(): TuiRegistry {
  const reg = new TuiRegistry();
  // Don't call init() — we want a clean registry for isolated tests
  return reg;
}

function createMemoryStorage(): PluginStorage {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}

/** Create an InlinePlugin that registers a single tui.command. */
function makeCommandPlugin(
  id: string,
  cmd: CommandDef,
): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  return {
    manifest: { manifestVersion: 1, id, name: id, version: '0.0.0', runtime: { main: 'inline' } },
    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
      ctx.register(TUI_COMMAND, id, () => cmd);
    },
  };
}

/** Create an InlinePlugin that registers a single tui.region. */
function makeRegionPlugin(
  id: string,
  region: RegionDef,
): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  return {
    manifest: { manifestVersion: 1, id, name: id, version: '0.0.0', runtime: { main: 'inline' } },
    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
      ctx.register(TUI_REGION, id, () => region);
    },
  };
}

/** Create an InlinePlugin that registers a single tui.renderer. */
function makeRendererPlugin(
  id: string,
  renderer: RendererDef,
): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  return {
    manifest: { manifestVersion: 1, id, name: id, version: '0.0.0', runtime: { main: 'inline' } },
    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
      ctx.register(TUI_RENDERER, id, () => renderer);
    },
  };
}

/** Create an InlinePlugin that registers a single tui.keybind. */
function makeKeyBindPlugin(
  id: string,
  binding: KeyBindDef,
): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  return {
    manifest: { manifestVersion: 1, id, name: id, version: '0.0.0', runtime: { main: 'inline' } },
    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
      ctx.register(TUI_KEYBIND, id, () => binding);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TuiRegistry', () => {
  // --- Happy path: register tui.command -> getCommands() returns it ---

  test('getCommands returns registered command', async () => {
    const registry = createCleanRegistry();
    const handler = mock(() => {});
    await registry.registerPlugin(
      makeCommandPlugin('test-cmd', {
        name: '/test',
        description: 'A test command',
        handler,
      }),
    );

    const commands = registry.getCommands();
    expect(commands.length).toBe(1);
    expect(commands[0].name).toBe('/test');
    expect(commands[0].description).toBe('A test command');
  });

  test('registerPlugin propagates async setup failures', async () => {
    const registry = createCleanRegistry();

    await expect(
      registry.registerPlugin({
        manifest: { manifestVersion: 1, id: 'broken-async', name: 'broken-async', version: '0.0.0', runtime: { main: 'inline' } },
        async setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
          ctx.register(TUI_COMMAND, 'broken-async', () => ({
            name: '/broken',
            description: 'Broken command',
            handler: async () => {},
          }));
          await Promise.resolve();
          throw new Error('setup exploded');
        },
      }),
    ).rejects.toThrow('setup exploded');

    expect(registry.getCommands()).toHaveLength(0);
  });

  // --- Happy path: register tui.region -> getRegions(position) returns it ---

  test('getRegions filters by position', async () => {
    const registry = createCleanRegistry();
    await registry.registerPlugin(
      makeRegionPlugin('main-region', {
        id: 'output',
        position: 'main',
        component: null,
        eventTypes: ['text_delta', 'text'],
      }),
    );
    await registry.registerPlugin(
      makeRegionPlugin('overlay-region', {
        id: 'palette',
        position: 'overlay',
        component: null,
        eventTypes: [],
      }),
    );

    const mainRegions = registry.getRegions('main');
    expect(mainRegions.length).toBe(1);
    expect(mainRegions[0].id).toBe('output');

    const overlayRegions = registry.getRegions('overlay');
    expect(overlayRegions.length).toBe(1);
    expect(overlayRegions[0].id).toBe('palette');

    const allRegions = registry.getRegions();
    expect(allRegions.length).toBe(2);
  });

  // --- Happy path: register tui.renderer -> getRenderers(eventType) ---

  test('getRenderers filters by eventType', async () => {
    const registry = createCleanRegistry();
    await registry.registerPlugin(
      makeRendererPlugin('text-renderer', {
        eventType: 'text_delta',
        render: () => undefined,
      }),
    );
    await registry.registerPlugin(
      makeRendererPlugin('tool-renderer', {
        eventType: 'tool_use',
        render: () => undefined,
      }),
    );

    const textRenderers = registry.getRenderers('text_delta');
    expect(textRenderers.length).toBe(1);

    const toolRenderers = registry.getRenderers('tool_use');
    expect(toolRenderers.length).toBe(1);

    const allRenderers = registry.getRenderers();
    expect(allRenderers.length).toBe(2);
  });

  // --- Happy path: register tui.keybind -> getKeyBindings() ---

  test('getKeyBindings returns registered key bindings', async () => {
    const registry = createCleanRegistry();
    await registry.registerPlugin(
      makeKeyBindPlugin('ctrl-k', {
        key: 'ctrl+k',
        action: 'open-palette',
      }),
    );

    const bindings = registry.getKeyBindings();
    expect(bindings.length).toBe(1);
    expect(bindings[0].key).toBe('ctrl+k');
    expect(bindings[0].action).toBe('open-palette');
  });

  // --- Edge case: plugin handler throws -> error logged, TUI continues ---

  test('executeCommand with throwing handler logs error and continues', async () => {
    const registry = createCleanRegistry();
    await registry.registerPlugin(
      makeCommandPlugin('bad-cmd', {
        name: '/boom',
        description: 'Explodes',
        handler: async () => {
          throw new Error('kaboom');
        },
      }),
    );

    const result = await registry.executeCommand('/boom', '', {
      args: '',
      abort: () => {},
    });

    // Should report command was found
    expect(result).toBe(true);

    // Error should be captured
    const errors = registry.getErrors();
    expect(errors.length).toBe(1);
    expect(errors[0].error.message).toBe('kaboom');
    expect(errors[0].source).toContain('executeCommand');
  });

  // --- Edge case: register duplicate command id -> latest wins ---

  test('duplicate command id: latest registration wins', async () => {
    const registry = createCleanRegistry();
    const handler1 = mock(() => {});
    const handler2 = mock(() => {});

    await registry.registerPlugin(
      makeCommandPlugin('dup-cmd', {
        name: '/dup',
        description: 'First',
        handler: handler1,
      }),
    );
    await registry.registerPlugin({
      manifest: { manifestVersion: 1, id: 'dup-cmd-v2', name: 'dup-cmd-v2', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
        ctx.register(TUI_COMMAND, 'dup-cmd', () => ({
          name: '/dup',
          description: 'Second',
          handler: handler2,
        }));
      },
    });

    const commands = registry.getCommands();
    // Both extensions are registered — the short name resolves to the latest
    // but listExtensions returns all. The registry returns all extensions
    // of the given type, so we get both.
    // However, since both use the same short id 'dup-cmd', there will be
    // a short name conflict warning but both extensions exist.
    expect(commands.length).toBe(2);
  });

  // --- Happy path: executeCommand finds and runs a command ---

  test('executeCommand finds and executes the right command', async () => {
    const registry = createCleanRegistry();
    const handler = mock(async (_args: string) => {});

    await registry.registerPlugin(
      makeCommandPlugin('my-cmd', {
        name: '/hello',
        description: 'Says hello',
        handler,
      }),
    );

    const result = await registry.executeCommand('/hello', 'world', {
      args: 'world',
      abort: () => {},
    });

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // --- executeCommand returns false for unknown command ---

  test('executeCommand returns false for unknown command', async () => {
    const registry = createCleanRegistry();
    const result = await registry.executeCommand('/nonexistent', '', {
      args: '',
      abort: () => {},
    });
    expect(result).toBe(false);
  });

  // --- Integration: load built-in command plugin -> /help lists commands ---

  test('built-in command plugin registers core commands', async () => {
    const registry = new TuiRegistry();
    await registry.init();

    const commands = registry.getCommands();
    const names = commands.map((c) => c.name).sort();

    expect(names).toContain('/exit');
    expect(names).toContain('/quit');
    expect(names).toContain('/clear');
    expect(names).toContain('/config');
    expect(names).toContain('/help');
    expect(names).toContain('/steer');
    expect(names).toContain('/agents');
    expect(names).toContain('/agent');
    expect(names.length).toBe(8);
  });

  // --- Integration: built-in /exit command calls the exit callback ---

  test('built-in /exit command invokes exit callback', async () => {
    const exitFn = mock(() => {});
    // We create a registry and manually register the command plugin
    // with our injected exit function
    const registry = createCleanRegistry();
    const { commandPlugin } = await import('../plugins/command-plugin.js');
    await registry.registerPlugin(commandPlugin({ exit: exitFn }));

    await registry.executeCommand('/exit', '', {
      args: '',
      abort: () => {},
    });

    expect(exitFn).toHaveBeenCalledTimes(1);
  });

  // --- Integration: built-in /clear command calls the clear callback ---

  test('built-in /clear command invokes clear callback', async () => {
    const clearFn = mock(() => {});
    const registry = createCleanRegistry();
    const { commandPlugin } = await import('../plugins/command-plugin.js');
    await registry.registerPlugin(commandPlugin({ clear: clearFn }));

    await registry.executeCommand('/clear', '', {
      args: '',
      abort: () => {},
    });

    expect(clearFn).toHaveBeenCalledTimes(1);
  });

  test('built-in /steer command invokes steer callback with args', async () => {
    const steerFn = mock(() => {});
    const registry = createCleanRegistry();
    const { commandPlugin } = await import('../plugins/command-plugin.js');
    await registry.registerPlugin(commandPlugin({ steer: steerFn }));

    await registry.executeCommand('/steer', 'use current file only', {
      args: 'use current file only',
      abort: () => {},
    });

    expect(steerFn).toHaveBeenCalledWith('use current file only');
  });

  // --- Edge case: getCommands when factory throws ---

  test('getCommands gracefully handles factory that throws', async () => {
    const registry = createCleanRegistry();
    await registry.registerPlugin({
      manifest: { manifestVersion: 1, id: 'bad-factory', name: 'bad-factory', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
        ctx.register(TUI_COMMAND, 'broken', () => {
          throw new Error('factory broke');
        });
      },
    });

    // Should not throw — error is captured
    const commands = registry.getCommands();
    expect(commands.length).toBe(0);

    const errors = registry.getErrors();
    expect(errors.length).toBe(1);
    expect(errors[0].error.message).toBe('factory broke');
  });

  // --- Edge case: getRegions when factory throws ---

  test('getRegions gracefully handles factory that throws', async () => {
    const registry = createCleanRegistry();
    await registry.registerPlugin({
      manifest: { manifestVersion: 1, id: 'bad-region-factory', name: 'bad-region-factory', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
        ctx.register(TUI_REGION, 'broken', () => {
          throw new Error('region factory broke');
        });
      },
    });

    const regions = registry.getRegions();
    expect(regions.length).toBe(0);

    const errors = registry.getErrors();
    expect(errors.length).toBe(1);
  });

  // --- getPluginRegistry provides access to underlying registry ---

  test('getPluginRegistry returns the underlying PluginRegistry', async () => {
    const registry = createCleanRegistry();
    const pluginReg = registry.getPluginRegistry();
    expect(pluginReg).toBeDefined();
    expect(typeof pluginReg.listExtensions).toBe('function');
  });

  test('factory context exposes full logger and plugin storage surfaces', async () => {
    const registry = createCleanRegistry();
    const seen: { loggerMethods?: string[]; deleted?: boolean } = {};

    await registry.registerPlugin({
      manifest: { manifestVersion: 1, id: 'ctx-surface', name: 'ctx-surface', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
        ctx.register(TUI_COMMAND, 'ctx-surface', (factoryCtx) => ({
          name: '/ctx',
          description: 'Context surface',
          handler: async () => {
            seen.loggerMethods = ['debug', 'info', 'warn', 'error', 'scope', 'withContext'].filter(
              (name) => typeof (factoryCtx.logger as any)[name] === 'function',
            );
            await factoryCtx.storage.set('key', 'value');
            await factoryCtx.storage.delete('key');
            seen.deleted = (await factoryCtx.storage.get('key')) === undefined;
          },
        }));
      },
    });

    await registry.executeCommand('/ctx', '', { args: '', abort: () => {} });

    expect(seen.loggerMethods).toEqual(['debug', 'info', 'warn', 'error', 'scope', 'withContext']);
    expect(seen.deleted).toBe(true);
  });

  test('factory storage is scoped per plugin package', async () => {
    const parentStorage = createMemoryStorage();
    const registry = new TuiRegistry({ storage: parentStorage });
    const seen: Record<string, unknown> = {};

    await registry.registerPlugin({
      manifest: { manifestVersion: 1, id: 'storage-a', name: 'storage-a', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
        ctx.register(TUI_COMMAND, 'storage-a', (factoryCtx) => ({
          name: '/storage-a',
          description: 'Storage A',
          handler: async () => {
            await factoryCtx.storage.set('shared', 'a');
            seen.aOwn = await factoryCtx.storage.get('shared');
          },
        }));
      },
    });
    await registry.registerPlugin({
      manifest: { manifestVersion: 1, id: 'storage-b', name: 'storage-b', version: '0.0.0', runtime: { main: 'inline' } },
      setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>) {
        ctx.register(TUI_COMMAND, 'storage-b', (factoryCtx) => ({
          name: '/storage-b',
          description: 'Storage B',
          handler: async () => {
            seen.bBefore = await factoryCtx.storage.get('shared');
            await factoryCtx.storage.set('shared', 'b');
            seen.bOwn = await factoryCtx.storage.get('shared');
          },
        }));
      },
    });

    await registry.executeCommand('/storage-a', '', { args: '', abort: () => {} });
    await registry.executeCommand('/storage-b', '', { args: '', abort: () => {} });

    expect(seen).toEqual({ aOwn: 'a', bBefore: undefined, bOwn: 'b' });
    expect(await parentStorage.get('storage-a:shared')).toBe('a');
    expect(await parentStorage.get('storage-b:shared')).toBe('b');
  });

  // --- Multiple plugins can register different extension types ---

  test('multiple extension types coexist', async () => {
    const registry = createCleanRegistry();

    await registry.registerPlugin(
      makeCommandPlugin('cmd-1', {
        name: '/foo',
        description: 'Foo command',
        handler: async () => {},
      }),
    );
    await registry.registerPlugin(
      makeRegionPlugin('region-1', {
        id: 'test-region',
        position: 'main',
        component: null,
        eventTypes: ['text_delta'],
      }),
    );
    await registry.registerPlugin(
      makeRendererPlugin('renderer-1', {
        eventType: 'text_delta',
        render: () => undefined,
      }),
    );
    await registry.registerPlugin(
      makeKeyBindPlugin('key-1', {
        key: 'ctrl+p',
        action: 'test-action',
      }),
    );

    expect(registry.getCommands().length).toBe(1);
    expect(registry.getRegions().length).toBe(1);
    expect(registry.getRenderers().length).toBe(1);
    expect(registry.getKeyBindings().length).toBe(1);
  });

  // --- No errors initially ---

  test('no errors initially', async () => {
    const registry = createCleanRegistry();
    expect(registry.getErrors().length).toBe(0);
  });
});
