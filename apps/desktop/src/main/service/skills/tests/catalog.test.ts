import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { discoverSkills, loadSkill, parseSkill } from "../catalog.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eta-skills-catalog-"));
  directories.push(root);
  const skill = async (source: string, name: string, body = "Private skill instructions") => {
    const directory = join(root, source, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Use this for ${source}\n---\n${body}`,
    );
    return directory;
  };
  return { root, skill };
}

test("discovery exposes only metadata, even when instructions exceed the activation limit", async () => {
  const { root, skill } = await fixture();
  await skill("user", "large", "Secret body".repeat(30000));
  const catalog = await discoverSkills([{ path: join(root, "user"), source: "user" }]);
  expect(catalog.issues).toEqual([]);
  expect(catalog.skills[0]).toMatchObject({ name: "large", description: "Use this for user" });
  expect(JSON.stringify(catalog)).not.toContain("Secret body");
  await expect(loadSkill(catalog.skills[0]!)).rejects.toThrow("256 KiB");
});

test("a partial file read cannot turn an invalid delimiter into valid frontmatter", async () => {
  const { root, skill } = await fixture();
  const directory = await skill("user", "review");
  const prefix = "---\nname: review\ndescription: test\n#";
  await writeFile(
    join(directory, "SKILL.md"),
    `${prefix}${"a".repeat(4096 - prefix.length - 4)}\n---invalid\nBody`,
  );
  const catalog = await discoverSkills([{ path: join(root, "user"), source: "user" }]);
  expect(catalog.skills).toEqual([]);
  expect(catalog.issues[0]?.message).toContain("frontmatter");
});

test("project skills override custom and user skills; disabling the winner does not silently expose another version", async () => {
  const { root, skill } = await fixture();
  for (const source of ["user", "custom", "project"]) await skill(source, "review");
  const sources = ["user", "custom", "project"].map((source) => ({
    path: join(root, source),
    source: source as "user" | "custom" | "project",
  }));
  const catalog = await discoverSkills(sources);
  const winner = catalog.skills.find((skill) => skill.source === "project")!;
  expect(catalog.skills.filter((skill) => skill.enabled)).toEqual([winner]);
  expect(catalog.skills.filter((skill) => skill.shadowedBy)).toHaveLength(2);
  expect((await discoverSkills(sources, [winner.id])).skills.every((skill) => !skill.enabled)).toBe(
    true,
  );
  expect((await discoverSkills(sources, [], false)).skills.every((skill) => !skill.enabled)).toBe(
    true,
  );
});

test("missing default roots and broken skills leave valid siblings discoverable", async () => {
  const { root, skill } = await fixture();
  await skill("user", "valid");
  const invalid = await skill("user", "invalid");
  await writeFile(
    join(invalid, "SKILL.md"),
    "---\nname: invalid\nname: duplicate\ndescription: wrong\n---\nInstructions",
  );
  const catalog = await discoverSkills([
    { path: join(root, "missing-default"), source: "user", optional: true },
    { path: join(root, "missing-custom"), source: "custom" },
    { path: join(root, "user"), source: "user" },
  ]);
  expect(catalog.skills.map((skill) => skill.name)).toEqual(["valid"]);
  expect(catalog.issues).toHaveLength(2);
  expect(catalog.issues.some((issue) => issue.message.includes("YAML"))).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "canonical paths deduplicate a skill discovered through multiple roots",
  async () => {
    const { root, skill } = await fixture();
    const directory = await skill("user", "review");
    await mkdir(join(root, "custom"));
    await symlink(directory, join(root, "custom", "review"));
    const catalog = await discoverSkills([
      { path: join(root, "user"), source: "user" },
      { path: join(root, "custom"), source: "custom" },
    ]);
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]?.source).toBe("custom");
  },
);

test.skipIf(process.platform === "win32")(
  "a project symlink retains project priority after deduplicating a user skill",
  async () => {
    const { root, skill } = await fixture();
    const directory = await skill("user", "review");
    await skill("custom", "review");
    await mkdir(join(root, "project"));
    await symlink(directory, join(root, "project", "review"));
    const catalog = await discoverSkills([
      { path: join(root, "user"), source: "user" },
      { path: join(root, "custom"), source: "custom" },
      { path: join(root, "project"), source: "project" },
    ]);
    expect(catalog.skills).toHaveLength(2);
    expect(catalog.skills.filter((skill) => skill.enabled)).toMatchObject([
      { source: "project", description: "Use this for user" },
    ]);
  },
);

test("custom roots may point directly at a skill and preserve referenced resources relative to that root", async () => {
  const { skill } = await fixture();
  const directory = await skill("custom", "review", "Read references/guide.md when needed.");
  const catalog = await discoverSkills([{ path: directory, source: "custom" }]);
  const loaded = await loadSkill(catalog.skills[0]!);
  expect(loaded.directory).toBe(catalog.skills[0]?.directory);
  expect(loaded.body).toBe("Read references/guide.md when needed.");
  expect(loaded.version).toMatch(/^[a-f0-9]{64}$/);
});

test.each([
  "---\nname: Review\ndescription: test\n---\nBody",
  "---\nname: other\ndescription: test\n---\nBody",
  "---\nname: review\ndescription: 123\n---\nBody",
  "---\nname: review\ndescription: ''\n---\nBody",
  "No frontmatter",
])("malformed metadata is rejected before registration", (content) => {
  expect(() => parseSkill(content, "review")).toThrow();
});
