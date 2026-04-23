import type { SkillInfo } from '@cortx/sdk';

export class SkillParseError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Failed to parse ${filePath}: ${reason}`);
    this.name = 'SkillParseError';
  }
}

export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new SkillParseError('<string>', 'no frontmatter delimiters found');

  const yaml = match[1];
  const body = match[2];
  const parsed = Bun.YAML.parse(yaml);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SkillParseError('<string>', 'frontmatter must be a YAML mapping');
  }
  const frontmatter = parsed as Record<string, unknown>;
  return { frontmatter, body };
}

export function parseSkillFile(raw: string, filePath: string, dirPath: string): SkillInfo {
  const { frontmatter, body } = parseFrontmatter(raw);

  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    throw new SkillParseError(filePath, 'missing or invalid "name" in frontmatter');
  }
  if (!frontmatter.description || typeof frontmatter.description !== 'string') {
    throw new SkillParseError(filePath, 'missing or invalid "description" in frontmatter');
  }

  let args: string[] | undefined;
  if (Array.isArray(frontmatter.arguments)) {
    if (!frontmatter.arguments.every((a: unknown) => typeof a === 'string')) {
      throw new SkillParseError(filePath, '"arguments" must be an array of strings');
    }
    args = frontmatter.arguments as string[];
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    arguments: args,
    content: body,
    dirPath,
  };
}
