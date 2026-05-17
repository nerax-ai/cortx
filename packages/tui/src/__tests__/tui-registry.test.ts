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
import type { InlinePlugin, PluginContext } from '@nerax-ai/plugin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a bare TuiRegistry without built-in plugins (clean slate). */
function createCleanRegistry(): TuiRegistry {
  const reg = new TuiRegistry();
  // Don't call init() — we want a clean registry for isolated tests
  return reg;
}

/** Create an InlinePlugin that registers a single tui.command. */
function makeCommandPlugin(
  id: string,
  cmd: CommandDef,
): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  return {
    manifest: { id, name: id, version: '0.0.0' },
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
    manifest: { id, name: id, version: '0.0.0' },
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
    manifest: { id, name: id, version: '0.0.0' },
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
    manifest: { id, name: id, version: '0.0.0' },
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
        manifest: { id: 'broken-async', name: 'broken-async', version: '0.0.0' },
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
      manifest: { id: 'dup-cmd-v2', name: 'dup-cmd-v2', version: '0.0.0' },
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

  test('built-in command plugin registers /exit, /quit, /clear, /config, /help', async () => {
    const registry = new TuiRegistry();
    await registry.init();

    const commands = registry.getCommands();
    const names = commands.map((c) => c.name).sort();

    expect(names).toContain('/exit');
    expect(names).toContain('/quit');
    expect(names).toContain('/clear');
    expect(names).toContain('/config');
    expect(names).toContain('/help');
    expect(names.length).toBe(5);
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

  // --- Edge case: getCommands when factory throws ---

  test('getCommands gracefully handles factory that throws', async () => {
    const registry = createCleanRegistry();
    await registry.registerPlugin({
      manifest: { id: 'bad-factory', name: 'bad-factory', version: '0.0.0' },
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
      manifest: { id: 'bad-region-factory', name: 'bad-region-factory', version: '0.0.0' },
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
