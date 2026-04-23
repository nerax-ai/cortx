import type { CortxPlugin, LanguageMessage, SkillInfo } from '@cortx/sdk';
import { parseInvocation, substituteArgs } from './substitute.js';
import { renderSkillSummary } from './render.js';
import { createSkillTool } from './tool.js';

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
    }
  }
  return '';
}

const SKILL_EXECUTION_GUIDANCE = `

---
**Skill execution active.** Continue using available tools to complete the task. Do not stop after summarizing or planning — take concrete action using your tools:
- **Agent tool**: dispatch a sub-agent for research, analysis, or focused sub-tasks
- **Bash**: run commands, install packages, execute scripts
- **Read**: examine file contents and understand code
- **Write / Edit**: create or modify files
- **Skill tool**: load another skill's instructions by name

Keep working until the skill's instructions are fully carried out. After each tool result, assess progress and continue.`;

function replaceLastMessage(messages: LanguageMessage[], lastIdx: number, last: LanguageMessage, newContent: string): LanguageMessage[] {
  return [...messages.slice(0, lastIdx), { ...last, content: newContent } as LanguageMessage];
}

export function createSkillPlugin(skills: SkillInfo[], cwd: string): CortxPlugin {
  const skillMap = new Map(skills.map(s => [s.name, s]));
  const skillTool = createSkillTool(skillMap, skills);

  return {
    'system.transform'(system: string): string {
      const summary = renderSkillSummary(skills);
      return summary ? system + '\n\n' + summary : system;
    },

    async 'messages.transform'(messages: LanguageMessage[]): Promise<LanguageMessage[]> {
      const lastIdx = messages.length - 1;
      const last = messages[lastIdx];
      if (!last || last.role !== 'user') return messages;

      const content = extractTextContent(last.content);
      const parsed = parseInvocation(content);
      if (!parsed) return messages;

      const skill = skillMap.get(parsed.skillName);
      if (!skill) {
        const available = skills.length > 20 ? skills.slice(0, 20).map(s => s.name).join(', ') + '...' : skills.map(s => s.name).join(', ');
        return replaceLastMessage(messages, lastIdx, last, `[Skill Error] Skill "${parsed.skillName}" not found. Available skills: ${available || 'none'}`);
      }

      const expanded = substituteArgs(skill.content, parsed.argsString, parsed.positionalArgs);
      return replaceLastMessage(messages, lastIdx, last, expanded + SKILL_EXECUTION_GUIDANCE);
    },

    tools: [skillTool],
  };
}
