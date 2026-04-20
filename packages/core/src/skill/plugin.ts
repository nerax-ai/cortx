import type { CortxPlugin, LanguageMessage } from '@cortx/sdk';
import type { SkillInfo } from '@cortx/sdk';
import { parseInvocation, substituteArgs } from './substitute.js';
import { renderSkillSummary } from './render.js';
import { createSkillTool } from './tool.js';

export function createSkillPlugin(skills: SkillInfo[], cwd: string): CortxPlugin {
  const skillMap = new Map(skills.map(s => [s.name, s]));
  const skillTool = createSkillTool(skills, cwd);

  return {
    'system.transform'(system: string): string {
      const summary = renderSkillSummary(skills);
      return summary ? system + '\n\n' + summary : system;
    },

    async 'messages.transform'(messages: LanguageMessage[]): Promise<LanguageMessage[]> {
      // Last element is the just-pushed user message (system messages are prepended by agentLoop)
      const lastIdx = messages.length - 1;
      const last = messages[lastIdx];
      if (!last || last.role !== 'user') return messages;

      const content = typeof last.content === 'string' ? last.content : '';
      const parsed = parseInvocation(content);
      if (!parsed) return messages;

      const skill = skillMap.get(parsed.skillName);
      if (!skill) {
        const replaced = { ...last, content: `[Skill Error] Skill "${parsed.skillName}" not found. Available skills: ${skills.map(s => s.name).join(', ') || 'none'}` };
        messages[lastIdx] = replaced;
        return messages;
      }

      const expanded = substituteArgs(skill.content, parsed.argsString, parsed.positionalArgs);
      const replaced = { ...last, content: expanded };
      messages[lastIdx] = replaced;
      return messages;
    },

    tools: [skillTool],
  };
}
