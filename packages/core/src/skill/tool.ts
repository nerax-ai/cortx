import type { Tool, ToolContext, ToolResult } from '@cortx/sdk';
import type { SkillInfo } from '@cortx/sdk';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export function createSkillTool(skills: SkillInfo[], cwd: string): Tool {
  const skillMap = new Map(skills.map(s => [s.name, s]));

  return {
    name: 'skill',
    description: 'Load a skill\'s full instructions by name. Use this when the task matches a skill\'s description.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name to load' },
      },
      required: ['name'],
    },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const name = input.name as string;
      const skill = skillMap.get(name);
      if (!skill) {
        const available = skills.map(s => s.name).join(', ') || 'none';
        return { success: false, error: `Skill "${name}" not found. Available: ${available}` };
      }

      let output = `# Skill: ${skill.name}\n\n${skill.content}`;

      // List companion files
      try {
        const companionFiles = await listCompanionFiles(skill.dirPath);
        if (companionFiles.length) {
          output += `\n\n## Companion Files\n${companionFiles.map(f => `- ${f}`).join('\n')}`;
        }
      } catch {
        // Directory may not be accessible
      }

      return { success: true, output };
    },
  };
}

async function listCompanionFiles(dirPath: string, maxFiles = 10): Promise<string[]> {
  const results: string[] = [];
  let count = 0;

  async function walk(dir: string, depth: number) {
    if (depth > 3 || count >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (count >= maxFiles) break;
      if (entry.name === 'SKILL.md' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        results.push(relative(dirPath, full));
        count++;
      } else if (entry.isDirectory()) {
        await walk(full, depth + 1);
      }
    }
  }

  await walk(dirPath, 0);
  return results;
}
