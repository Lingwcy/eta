import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import { parseDocument } from "yaml";
import type { SkillCatalog, SkillMetadata } from "../../../skills/types.ts";

const Metadata = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  compatibility: Schema.optionalKey(Schema.String),
});

/** Bound file reads before parsing so one oversized skill does not exhaust the catalog scan. */
async function readSkill(path: string, metadataOnly = false) {
  const file = await open(path, "r");
  try {
    const limit = metadataOnly ? 64 * 1024 : 256 * 1024;
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const chunk = await file.read(buffer, bytes, Math.min(4096, buffer.length - bytes), null);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
      if (metadataOnly) {
        const text = buffer.subarray(0, bytes).toString("utf8");
        const frontmatter = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
        if (frontmatter) return frontmatter[0];
      }
    }
    if (bytes === buffer.length)
      throw new Error(
        metadataOnly ? "Skill frontmatter exceeds 64 KiB" : "SKILL.md exceeds 256 KiB",
      );
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    await file.close();
  }
}

export function parseSkill(text: string, directoryName: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error("SKILL.md requires YAML frontmatter");
  const yaml = parseDocument(match[1]);
  if (yaml.errors.length) throw new Error("SKILL.md has invalid YAML frontmatter");
  const metadata = Schema.decodeUnknownSync(Metadata)(yaml.toJS());
  if (
    metadata.name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) ||
    metadata.name !== directoryName
  )
    throw new Error(
      "Skill name must match its directory and use lowercase letters, numbers and hyphens",
    );
  if (metadata.description.length > 1024 || !metadata.description.trim())
    throw new Error("Skill description must contain 1–1024 characters");
  if ((metadata.compatibility?.length ?? 0) > 500)
    throw new Error("Skill compatibility must not exceed 500 characters");
  return { ...metadata, body: match[2].trim() };
}

/** Sources are ordered from user defaults to project overrides; only immediate skill directories are scanned. */
export async function discoverSkills(
  sources: {
    path: string;
    source: SkillMetadata["source"];
    optional?: boolean;
    configuredPath?: string;
  }[],
  disabled: readonly string[] = [],
  enabled = true,
): Promise<SkillCatalog> {
  const catalog: SkillCatalog = { directories: [], skills: [], issues: [] };
  const disabledIds = new Set(disabled);
  const entries = new Map<string, SkillMetadata>();
  for (const source of sources) {
    const root = resolve(source.path);
    const index = catalog.directories.findIndex((directory) => directory.path === root);
    const configuredPaths = [
      ...new Set([
        ...(catalog.directories[index]?.configuredPaths ?? []),
        ...(source.configuredPath ? [source.configuredPath] : []),
      ]),
    ];
    const directory = {
      path: root,
      source: source.source,
      ...(configuredPaths.length ? { configuredPaths } : {}),
    };
    if (index < 0) catalog.directories.push(directory);
    else catalog.directories[index] = directory;
    let children;
    try {
      children = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (source.optional && hasCode(error, "ENOENT")) continue;
      catalog.issues.push({ path: root, message: "无法读取技能目录" });
      continue;
    }
    const paths = children.some((entry) => entry.name === "SKILL.md" && entry.isFile())
      ? [join(root, "SKILL.md")]
      : children
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .sort((a, b) => a.name.localeCompare(b.name, "en"))
          .map((entry) => join(root, entry.name, "SKILL.md"));
    for (const path of paths) {
      try {
        const canonical = await realpath(path);
        const parsed = parseSkill(await readSkill(canonical, true), basename(dirname(path)));
        entries.delete(canonical);
        entries.set(canonical, {
          id: canonical,
          name: parsed.name,
          description: parsed.description,
          path: canonical,
          directory: dirname(canonical),
          source: source.source,
          ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
          enabled: enabled && !disabledIds.has(canonical),
        });
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        catalog.issues.push({
          path,
          message: error instanceof Error ? error.message : "无法读取技能",
        });
      }
    }
  }
  const winners = new Map<string, SkillMetadata>();
  for (const skill of entries.values()) winners.set(skill.name, skill);
  catalog.skills = [...entries.values()]
    .map((skill) => {
      const winner = winners.get(skill.name)!;
      return winner.id === skill.id ? skill : { ...skill, enabled: false, shadowedBy: winner.path };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
  return catalog;
}

export async function loadSkill(skill: SkillMetadata) {
  const text = await readSkill(skill.path);
  const parsed = parseSkill(text, skill.name);
  if (!parsed.body) throw new Error("Skill instructions are empty");
  return {
    id: skill.id,
    name: skill.name,
    directory: skill.directory,
    version: createHash("sha256").update(text).digest("hex"),
    body: parsed.body,
  };
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
