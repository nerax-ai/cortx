import { createStorage } from '@nerax-ai/storage';
import type { ProviderConfig, GroupConfig } from '@synax-ai/sdk';

export interface CortxConfig {
  model: string;
  system?: string;
  maxIterations?: number;
  workingDirectory?: string;
  plugins?: string[];
  providers?: ProviderConfig[];
  groups?: GroupConfig[];
}

const DEFAULT_CONFIG: CortxConfig = {
  model: 'default',
  system: 'You are a helpful coding assistant. You have access to tools to read, write, and execute code.',
  maxIterations: 200,
};

function storage() {
  return createStorage('cortx');
}

export async function loadConfig(): Promise<CortxConfig> {
  const saved = await storage().config.readJSON<CortxConfig>('cortx.json');
  return saved ? { ...DEFAULT_CONFIG, ...saved } : DEFAULT_CONFIG;
}

export async function saveConfig(config: CortxConfig): Promise<void> {
  await storage().config.writeJSON('cortx.json', config);
}

export async function ensureConfig(): Promise<CortxConfig> {
  return loadConfig();
}

export function getConfigDir(): string {
  return storage().config.path;
}
