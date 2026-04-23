import type { SkillInfo } from '@cortx/sdk';

const GUIDANCE = `
To load a skill's full instructions, use the \`skill\` tool with the skill name. Call it when the task matches a skill's description.`;

export function renderSkillSummary(skills: SkillInfo[], budget = 2000): string {
  if (!skills.length) return '';

  const header = '## Available Skills\n\n';
  const lines = skills.map(s => `- ${s.name}: ${s.description}`);
  let body = lines.join('\n');
  let section = header + body + '\n' + GUIDANCE;

  if (section.length > budget) {
    // Iteratively truncate entries until total fits within budget
    const maxBody = budget - header.length - GUIDANCE.length - 1; // -1 for newline before GUIDANCE
    const perSkill = Math.max(20, Math.floor(maxBody / skills.length));
    const truncated: string[] = [];
    for (const s of skills) {
      if (truncated.join('\n').length >= maxBody) break;
      const entry = `- ${s.name}: ${s.description}`;
      truncated.push(entry.length > perSkill ? entry.slice(0, perSkill - 3) + '...' : entry);
    }
    body = truncated.join('\n');
    section = header + body + '\n' + GUIDANCE;
    // Final safety: if still over budget, truncate the body
    if (section.length > budget) {
      const overBy = section.length - budget;
      body = body.slice(0, Math.max(0, body.length - overBy));
      section = header + body + '\n' + GUIDANCE;
    }
  }

  return section;
}
