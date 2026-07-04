import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface SkillPack {
  name?: string;
  path: string;
  skillPaths: string[];
  agentSpecPaths: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSkillPack(path: string): Promise<SkillPack> {
  const root = resolve(path);
  const skillPaths: string[] = [];
  const agentSpecPaths: string[] = [];
  const skillsDir = join(root, 'skills');
  const cortxSkillsDir = join(root, '.cortx', 'skills');
  const agentsDir = join(root, 'agents');

  if (await exists(skillsDir)) skillPaths.push(skillsDir);
  if (await exists(cortxSkillsDir)) skillPaths.push(cortxSkillsDir);
  if (await exists(agentsDir)) agentSpecPaths.push(agentsDir);

  return {
    path: root,
    name: root.split(/[\\/]/).filter(Boolean).at(-1),
    skillPaths,
    agentSpecPaths,
  };
}
