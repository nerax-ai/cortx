export interface PluginSourceConfig {
  workspaceToolsPlugin?: string | false;
  plugins?: string[];
}

export interface PluginSourceDefaults {
  environmentWorkspaceToolsPlugin?: string;
  defaultWorkspaceToolsPlugin?: string;
}

/** Resolve the official workspace-tools source before additional product plugins. */
export function configuredPluginSources(
  config: PluginSourceConfig,
  defaults: PluginSourceDefaults = {},
): string[] {
  const workspaceTools =
    config.workspaceToolsPlugin === false
      ? undefined
      : nonEmpty(config.workspaceToolsPlugin) ??
        nonEmpty(defaults.environmentWorkspaceToolsPlugin) ??
        nonEmpty(defaults.defaultWorkspaceToolsPlugin);
  return [...new Set([...(workspaceTools ? [workspaceTools] : []), ...(config.plugins ?? []).filter(nonEmpty)])];
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
