import type { SkillInfo } from '@cortx/sdk';

const GUIDANCE = `
To load a skill's full instructions, use the \`skill\` tool with the skill name. Call it when the task matches a skill's description.`;

export function renderSkillSummary(skills: SkillInfo[], budget = 2000): string {
  if (!skills.length) return '';

  const lines = skills.map(s => `- ${s.name}: ${s.description}`);
  let header = '## Available Skills\n\n';
  let body = lines.join('\n');
  let section = header + body + '\n' + GUIDANCE;

  if (section.length > budget) {
    const available = budget - header.length - GUIDANCE.length - skills.length; // rough budget per line
    const perSkill = Math.max(20, Math.floor(available / skills.length));
    const truncated = skills.map(s => {
      const entry = `- ${s.name}: ${s.description}`;
      return entry.length > perSkill ? entry.slice(0, perSkill - 3) + '...' : entry;
    });
    body = truncated.join('\n');
    section = header + body + '\n' + GUIDANCE;
  }

  return section;
}
