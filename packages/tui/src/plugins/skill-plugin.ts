/**
 * Skill discovery for the TUI layer.
 *
 * Discovers SKILL.md files and returns them as display-only items for the
 * command palette. When the user selects a skill from the palette, the text
 * `/skill-name ` is injected into the input field (not executed as a command).
 * On submit, `handleSubmit` sends it to the agent, where the runtime skill
 * asset bridge expands it through `agent.messagesTransform`.
 */

import type { SkillInfo } from '@cortx/sdk';
import { discoverSkills } from '@cortx/runtime';

export interface SkillItem {
  name: string;
  description: string;
}

export async function discoverSkillItems(cwd: string): Promise<SkillItem[]> {
  const skills: SkillInfo[] = await discoverSkills(cwd, {});
  return skills.map((s) => ({
    name: s.name,
    description: s.description.length > 80
      ? s.description.slice(0, 77) + '...'
      : s.description,
  }));
}
