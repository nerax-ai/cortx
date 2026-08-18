import type { ReactNode } from 'react';
import type { AgentEvent } from '@cortx/sdk';
import type { Logger } from '@nerax-ai/logger';
import type {
  ContributionBinding,
  ContributionHostContext,
  DeclarativePlugin,
  DeclarativePluginContext,
  JsonObject,
  ManifestContributionDescriptor,
  PluginStorage,
} from '@nerax-ai/plugin';

export const TUI_COMMAND = 'tui.command' as const;
export const TUI_RENDERER = 'tui.renderer' as const;

export const TUI_CONTRIBUTION_TYPES = [TUI_COMMAND, TUI_RENDERER] as const;
export type TuiContributionType = (typeof TUI_CONTRIBUTION_TYPES)[number];

export interface CommandContext {
  args: string;
  abort(): void;
}

export interface CommandDef {
  name: string;
  description: string;
  handler(args: string, ctx: CommandContext): void | Promise<void>;
}

export interface RendererDef {
  eventType: string;
  render(event: AgentEvent): ReactNode | undefined;
}

export interface TuiContributionMap {
  [TUI_COMMAND]: CommandDef;
  [TUI_RENDERER]: RendererDef;
}

export interface TuiContributionHostContext<TValue = unknown> extends ContributionHostContext<TValue> {
  readonly instanceId: string;
  readonly logger: Logger;
  readonly storage?: PluginStorage;
  defer(disposer: () => void | Promise<void>, label?: string): void;
  acquire<T>(
    acquire: (signal: AbortSignal) => T | Promise<T>,
    dispose: (resource: T) => void | Promise<void>,
    label?: string,
  ): Promise<T>;
}

export type TuiContributionBinding<TType extends TuiContributionType> = ContributionBinding<
  TType,
  TuiContributionMap[TType],
  TuiContributionHostContext<TuiContributionMap[TType]>
>;

export type TuiPluginContext = Omit<DeclarativePluginContext, 'bind'> & {
  bind<TType extends TuiContributionType>(binding: TuiContributionBinding<TType>): void;
};

export type TuiPlugin = DeclarativePlugin;

export function defineTuiContributionDescriptor(
  descriptor: ManifestContributionDescriptor,
): ManifestContributionDescriptor {
  return descriptor;
}

export function defineTuiContributionBinding<TType extends TuiContributionType>(
  type: TType,
  id: string,
  factory: TuiContributionBinding<TType>['factory'],
): TuiContributionBinding<TType> {
  return { type, id, factory };
}

export function isTuiContributionType(value: string): value is TuiContributionType {
  return (TUI_CONTRIBUTION_TYPES as readonly string[]).includes(value);
}

export function tuiContributionOptions(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
