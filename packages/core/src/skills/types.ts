export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  path: string;
  directory: string;
  source: "user" | "custom" | "project";
  compatibility?: string;
  enabled: boolean;
  shadowedBy?: string;
}

export interface SkillDirectory {
  path: string;
  source: SkillMetadata["source"];
  configuredPaths?: string[];
}

export interface SkillCatalog {
  directories: SkillDirectory[];
  skills: SkillMetadata[];
  issues: { path: string; message: string }[];
}

export interface ActiveSkill {
  id: string;
  name: string;
  directory: string;
  version: string;
}
