import { describe, expect, test } from 'bun:test';
import { configuredPluginSources } from '../src/plugin-sources';

describe('server plugin source resolution', () => {
  test('uses the official workspace-tools fallback before additional plugins', () => {
    expect(configuredPluginSources(
      { plugins: ['file:/plugins/extra'] },
      { defaultWorkspaceToolsPlugin: 'file:/official/workspace-tools' },
    )).toEqual(['file:/official/workspace-tools', 'file:/plugins/extra']);
  });

  test('prefers config over environment and environment over the local fallback', () => {
    const defaults = {
      environmentWorkspaceToolsPlugin: 'file:/environment/workspace-tools',
      defaultWorkspaceToolsPlugin: 'file:/official/workspace-tools',
    };
    expect(configuredPluginSources({ workspaceToolsPlugin: ' file:/configured/workspace-tools ' }, defaults))
      .toEqual(['file:/configured/workspace-tools']);
    expect(configuredPluginSources({}, defaults)).toEqual(['file:/environment/workspace-tools']);
  });

  test('supports explicitly disabling workspace tools and removes duplicate sources', () => {
    expect(configuredPluginSources({
      workspaceToolsPlugin: false,
      plugins: ['file:/plugins/extra', 'file:/plugins/extra', '  '],
    }, {
      environmentWorkspaceToolsPlugin: 'file:/environment/workspace-tools',
      defaultWorkspaceToolsPlugin: 'file:/official/workspace-tools',
    })).toEqual(['file:/plugins/extra']);
  });
});
