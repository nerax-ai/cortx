/**
 * Markdown plugin — registers the streaming markdown renderer as a first-party TUI plugin.
 *
 * Registers:
 *   tui.region('output')  — the output region uses markdown rendering
 *   tui.renderer('text_delta') — renders text_delta events through the markdown pipeline
 *
 * The actual rendering is handled by the OutputRegion component which reads
 * from the store's messages field and passes it to the Markdown component.
 * This plugin mainly serves as a registration placeholder for the extension
 * system and future extension points.
 */

import type { InlinePlugin, PluginContext } from '@nerax-ai/plugin';
import type { TuiFactoryMap, TuiExtensionType, RendererDef, RegionDef } from '../types/tui-plugin.js';
import { TUI_REGION, TUI_RENDERER } from '../types/tui-plugin.js';

export function markdownPlugin(): InlinePlugin<TuiExtensionType, TuiFactoryMap> {
  return {
    manifest: {
      id: '@cortx/tui-markdown',
      name: 'TUI Markdown Renderer',
      version: '1.0.0',
      description: 'Streaming markdown renderer for agent text output',
    },

    setup(ctx: PluginContext<TuiExtensionType, TuiFactoryMap>): void {
      // Register the output region
      ctx.register(TUI_REGION, 'output', () => ({
        id: 'output',
        position: 'main',
        component: null, // Actual component is wired in app-shell
        eventTypes: ['text_delta', 'text', 'thinking_delta', 'thinking'],
      }) satisfies RegionDef);

      // Register the text_delta renderer
      ctx.register(TUI_RENDERER, 'text_delta', () => ({
        eventType: 'text_delta',
        render: () => undefined, // Actual rendering happens via OutputRegion -> Markdown
      }) satisfies RendererDef);
    },
  };
}
