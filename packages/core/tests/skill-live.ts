/**
 * Live skill system test — exercises discovery, parsing, plugin hooks, and tool execution
 * against real CE skills copied into .cortx/skills/
 */
import { discoverSkills } from '../src/skill/discover.js';
import { createSkillPlugin } from '../src/skill/plugin.js';
import { parseInvocation, substituteArgs } from '../src/skill/substitute.js';
import { renderSkillSummary } from '../src/skill/render.js';

const cwd = process.cwd();

console.log('=== Skill System Live Test ===\n');

// 1. Discovery
console.log('1. Discovering skills from .cortx/skills/...');
const warnings: string[] = [];
const skills = await discoverSkills(cwd, {}, { warn: (msg) => warnings.push(msg) });
console.log(`   Found ${skills.length} skill(s):`);
for (const s of skills) {
  console.log(`   - ${s.name}: ${s.description.slice(0, 80)}...`);
}
if (warnings.length) {
  console.log(`   Warnings: ${warnings.join('; ')}`);
}
console.log();

if (skills.length === 0) {
  console.error('ERROR: No skills discovered. Make sure .cortx/skills/ has SKILL.md files.');
  process.exit(1);
}

// 2. System prompt injection
console.log('2. Testing system.transform...');
const plugin = createSkillPlugin(skills, cwd);
const basePrompt = 'You are a helpful coding assistant.';
const systemPrompt = plugin['system.transform']!(basePrompt);
const hasSummary = systemPrompt.includes('## Available Skills');
console.log(`   Base prompt injected: ${hasSummary ? 'YES' : 'NO'}`);
const gitCommitFound = systemPrompt.includes('git-commit');
console.log(`   git-commit skill listed: ${gitCommitFound ? 'YES' : 'NO'}`);
console.log();

// 3. Pre-parse with /skill-name
console.log('3. Testing messages.transform with /git-commit...');
const messages = [
  { role: 'user', content: '/git-commit fix: skill system tests' },
];
const transformed = await plugin['messages.transform']!(messages as any);
const lastContent = Array.isArray(transformed[0].content)
  ? (transformed[0].content as any[]).find((p: any) => p.type === 'text')?.text
  : transformed[0].content;
const expanded = typeof lastContent === 'string' ? lastContent : '';
const wasExpanded = expanded.includes('Git Commit') && !expanded.startsWith('/git-commit');
console.log(`   Skill expanded: ${wasExpanded ? 'YES' : 'NO'}`);
console.log(`   Content preview: ${expanded.slice(0, 120)}...`);
console.log();

// 4. Unknown skill error
console.log('4. Testing unknown skill error...');
const badMessages = [{ role: 'user', content: '/nonexistent-skill' }];
const badResult = await plugin['messages.transform']!(badMessages as any);
const badContent = Array.isArray(badResult[0].content)
  ? (badResult[0].content as any[]).find((p: any) => p.type === 'text')?.text
  : badResult[0].content;
const hasError = typeof badContent === 'string' && badContent.includes('Skill Error');
console.log(`   Error message returned: ${hasError ? 'YES' : 'NO'}`);
console.log();

// 5. Skill tool execution
console.log('5. Testing skill tool execution...');
const tool = plugin.tools![0];
const toolResult = await tool.execute({ name: 'git-commit' }, {
  sessionId: 'test-session',
  workingDirectory: cwd,
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, scope() { return this; } },
});
console.log(`   Tool success: ${toolResult.success ? 'YES' : 'NO'}`);
console.log(`   Output preview: ${String(toolResult.output).slice(0, 120)}...`);
console.log();

// 6. Argument substitution
console.log('6. Testing argument substitution...');
const parsed = parseInvocation('/git-commit fix: typo in README');
console.log(`   Parsed skill: ${parsed?.skillName}`);
console.log(`   Parsed args: ${parsed?.argsString}`);
console.log(`   Positional: ${JSON.stringify(parsed?.positionalArgs)}`);
const subResult = substituteArgs('Create a commit: $ARGUMENTS\nUse $1 as prefix.', 'fix: typo in README', ['fix:', 'typo', 'in', 'README']);
console.log(`   Substituted: ${subResult}`);
console.log();

// 7. Immutability check
console.log('7. Testing immutability...');
const origMsgs = [{ role: 'user', content: '/git-commit fix: test' }];
const origRef = origMsgs[0];
await plugin['messages.transform']!(origMsgs as any);
const isImmutable = origMsgs[0] === origRef;
console.log(`   Original array unchanged: ${isImmutable ? 'YES' : 'NO'}`);
console.log();

// Summary
console.log('=== Summary ===');
const allPassed = skills.length > 0 && hasSummary && wasExpanded && hasError && toolResult.success && isImmutable;
console.log(`All checks passed: ${allPassed ? 'YES ✓' : 'NO ✗'}`);
console.log(`Skills discovered: ${skills.length}`);
console.log(`Tests: discovery, system.transform, messages.transform (skill + error), tool, substitution, immutability`);
