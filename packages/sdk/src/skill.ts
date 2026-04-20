export interface SkillFrontmatter {
  name: string;
  description: string;
  arguments?: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  arguments?: string[];
  content: string;
  dirPath: string;
}
