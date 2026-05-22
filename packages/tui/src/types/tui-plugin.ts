/**
 * TUI extension types and interfaces.
 *
 * These types define the plugin extension points for the TUI layer.
 * Plugins register extensions via `ctx.register(type, id, factory)` where
 * `type` is one of the TUI extension type constants.
 *
 * The factory function signature matches @nerax-ai/plugin's convention:
 * `(ctx) => value` where ctx provides { instanceId, options, logger, storage }.
 */

import type { ReactNode } from 'react';
import type { AgentEvent } from '@cortx/sdk';
import type { Logger } from '@nerax-ai/logger';
import type { PluginStorage } from '@nerax-ai/plugin';

// ---------------------------------------------------------------------------
// Extension type constants
// ---------------------------------------------------------------------------

/** Extension type for TUI commands (e.g. /help, /clear). */
export const TUI_COMMAND = 'tui.command' as const;

/** Extension type for TUI regions (e.g. output, tools, status, input). */
export const TUI_REGION = 'tui.region' as const;

/** Extension type for TUI event renderers. */
export const TUI_RENDERER = 'tui.renderer' as const;

/** Extension type for TUI key bindings. */
export const TUI_KEYBIND = 'tui.keybind' as const;

/** Union of all TUI extension type constants. */
export type TuiExtensionType =
  | typeof TUI_COMMAND
  | typeof TUI_REGION
  | typeof TUI_RENDERER
  | typeof TUI_KEYBIND;

// ---------------------------------------------------------------------------
// Command extension (tui.command)
// ---------------------------------------------------------------------------

/** Context provided to command handlers. */
export interface CommandContext {
  /** Arguments string after the command name (e.g. "/config key value" -> "key value"). */
  args: string;
  /** Abort the current agent run if one is active. */
  abort: () => void;
}

/** Definition returned by a tui.command factory. */
export interface CommandDef {
  /** The slash command name, including the leading slash (e.g. "/help"). */
  name: string;
  /** Short description shown in /help and command palette. */
  description: string;
  /** Execute the command. */
  handler: (args: string, ctx: CommandContext) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Region extension (tui.region)
// ---------------------------------------------------------------------------

/** Layout positions where a region can be placed. */
export type RegionPosition = 'main' | 'overlay';

/** Definition returned by a tui.region factory. */
export interface RegionDef {
  /** Unique region identifier. */
  id: string;
  /** Where this region should be placed in the layout. */
  position: RegionPosition;
  /** React component to render for this region. */
  component: ReactNode;
  /** AgentEvent types this region is interested in. */
  eventTypes: string[];
}

// ---------------------------------------------------------------------------
// Renderer extension (tui.renderer)
// ---------------------------------------------------------------------------

/** Definition returned by a tui.renderer factory. */
export interface RendererDef {
  /** The AgentEvent type this renderer handles (e.g. "text_delta", "tool_use"). */
  eventType: string;
  /**
   * Render the event for a given region.
   * Returns a ReactNode to display, or undefined to let the default handler run.
   */
  render: (event: AgentEvent) => ReactNode | undefined;
}

// ---------------------------------------------------------------------------
// Key binding extension (tui.keybind)
// ---------------------------------------------------------------------------

/** Definition returned by a tui.keybind factory. */
export interface KeyBindDef {
  /** Key sequence description (e.g. "ctrl+k", "escape"). */
  key: string;
  /** Action identifier to dispatch when the key is pressed. */
  action: string;
}

// ---------------------------------------------------------------------------
// Factory map — maps extension type strings to their factory return types.
// Used to type the PluginRegistry when creating a TuiRegistry.
// ---------------------------------------------------------------------------

export interface TuiFactoryMap {
  [TUI_COMMAND]: (ctx: TuiFactoryContext) => CommandDef;
  [TUI_REGION]: (ctx: TuiFactoryContext) => RegionDef;
  [TUI_RENDERER]: (ctx: TuiFactoryContext) => RendererDef;
  [TUI_KEYBIND]: (ctx: TuiFactoryContext) => KeyBindDef;
}

/** Context object passed to factory functions. */
export interface TuiFactoryContext {
  instanceId: string;
  options: Record<string, unknown>;
  logger: Logger;
  storage: PluginStorage;
}
