#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

export interface PublishedRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}

const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function command(root: string, program: string, args: string[]) {
  return execFileSync(program, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function version(tag: string) {
  if (!versionPattern.test(tag)) throw new Error(`Expected a stable version tag vX.Y.Z: ${tag}`);
  return tag.slice(1);
}

/** Validate the checked-out source before naming any installer after a tag. */
export function validateRelease(root: string, tag: string) {
  const expected = version(tag);
  for (const path of ["package.json", "apps/desktop/package.json"]) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as { version: string };
    if (manifest.version !== expected)
      throw new Error(`${path} version ${manifest.version} does not match ${tag}`);
  }
  const revision = command(root, "git", ["rev-parse", `refs/tags/${tag}^{commit}`]);
  if (command(root, "git", ["rev-parse", "HEAD"]) !== revision)
    throw new Error(`Check out ${tag} before releasing it`);
  return revision;
}

function olderThan(candidate: string, tag: string) {
  const left = version(candidate).split(".").map(BigInt);
  const right = version(tag).split(".").map(BigInt);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index]! < right[index]!;
  }
  return false;
}

/** Ignore unpublished tags and releases from unrelated branches when choosing the baseline. */
export function previousRelease(root: string, tag: string, releases: readonly PublishedRelease[]) {
  version(tag);
  const candidates = releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        release.published_at &&
        versionPattern.test(release.tag_name) &&
        olderThan(release.tag_name, tag),
    )
    .toSorted((left, right) => right.published_at!.localeCompare(left.published_at!));
  const ancestors = new Set(command(root, "git", ["tag", "--merged", tag]).split("\n"));
  for (const release of candidates) {
    // Full checkout history must include every published tag; otherwise a partial log looks complete.
    command(root, "git", ["rev-parse", "--verify", `refs/tags/${release.tag_name}^{commit}`]);
    if (ancestors.has(release.tag_name)) return release.tag_name;
  }
}

function escapeMarkdown(text: string) {
  return text.replace(/[\\`*_{}[\]<>|]/g, "\\$&");
}

const groups = [
  "不兼容变更",
  "新增功能",
  "修复",
  "性能优化",
  "重构",
  "文档",
  "测试",
  "维护",
  "其他",
];
const types = new Map([
  ["feat", "新增功能"],
  ["fix", "修复"],
  ["perf", "性能优化"],
  ["refactor", "重构"],
  ["docs", "文档"],
  ["test", "测试"],
  ["chore", "维护"],
  ["ci", "维护"],
  ["build", "维护"],
  ["style", "维护"],
]);

/** Keep commit descriptions as evidence instead of inventing changes from their titles. */
export function releaseNotes(root: string, tag: string, repository: string, previous?: string) {
  version(tag);
  const range = previous ? `${previous}..${tag}` : tag;
  const log = command(root, "git", [
    "log",
    "--reverse",
    "--no-merges",
    "--format=%H%x00%s%x00%b%x00",
    range,
  ]);
  const fields = log.split("\0");
  const entries = new Map<string, string[]>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const hash = fields[index]!.trim();
    const subject = fields[index + 1]!.trim();
    const body = fields[index + 2]!;
    const conventional = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
    const [, type, scope, breaking, description] = conventional ?? [];
    if (type === "chore" && scope === "release") continue;
    const group =
      breaking || /^BREAKING[ -]CHANGE:/m.test(body)
        ? "不兼容变更"
        : scope === "comment"
          ? "维护"
          : (types.get(type ?? "") ?? "其他");
    const label = `${scope ? `${scope}：` : ""}${description ?? subject}`;
    const entry = `- ${escapeMarkdown(label)} ([${hash.slice(0, 7)}](https://github.com/${repository}/commit/${hash}))`;
    entries.set(group, [...(entries.get(group) ?? []), entry]);
  }
  const introduction = previous
    ? `本次更新包含 ${previous} 之后的提交。`
    : "Eta 桌面端首次自动发布。";
  const sections = groups
    .filter((group) => entries.has(group))
    .map((group) => `### ${group}\n\n${entries.get(group)!.join("\n")}`);
  if (!sections.length) sections.push("### 更新内容\n\n此版本没有新增的功能或修复提交。");
  const compare = previous
    ? `https://github.com/${repository}/compare/${previous}...${tag}`
    : `https://github.com/${repository}/commits/${tag}`;
  return `${introduction}\n\n${sections.join("\n\n")}\n\n[完整提交记录](${compare})\n`;
}

/** Both architecture files must exist before a release draft is created. */
export function installerChecksums(directory: string, tag: string) {
  const expected = version(tag);
  return ["arm64", "x64"].map((arch) => {
    const name = `Eta-${expected}-mac-${arch}.dmg`;
    const path = join(directory, name);
    const data = readFileSync(path);
    if (!data.length) throw new Error(`Empty installer: ${name}`);
    return { name, path, digest: createHash("sha256").update(data).digest("hex") };
  });
}

interface UpdateFeed {
  version: string;
  files: { url: string; sha512: string; size: number }[];
  path: string;
  sha512: string;
  releaseDate: string;
}

/**
 * electron-updater reads one latest-mac.yml for every architecture. Each CI job writes its own
 * latest-mac-<arch>.yml; a local `--arm64 --x64` build writes a combined latest-mac.yml.
 */
export function updateFeed(directory: string, tag: string) {
  const expected = version(tag);
  const sources = readdirSync(directory).filter((name) => /^latest-mac-\w+\.yml$/.test(name));
  if (!sources.length && existsSync(join(directory, "latest-mac.yml")))
    sources.push("latest-mac.yml");
  const feeds = sources.map(
    (name) => parse(readFileSync(join(directory, name), "utf8")) as UpdateFeed,
  );
  const files = new Map<string, UpdateFeed["files"][number]>();
  for (const feed of feeds) {
    if (feed.version !== expected)
      throw new Error(`Update feed version ${feed.version} does not match ${tag}`);
    for (const file of feed.files) files.set(file.url, file);
  }
  const uploads: string[] = [];
  for (const file of files.values()) {
    const path = join(directory, file.url);
    const digest = createHash("sha512").update(readFileSync(path)).digest("base64");
    if (digest !== file.sha512) throw new Error(`Update feed checksum mismatch: ${file.url}`);
    uploads.push(path);
    // Only zips are downloaded by the updater, so only their blockmaps enable differential updates.
    if (file.url.endsWith(".zip") && existsSync(`${path}.blockmap`))
      uploads.push(`${path}.blockmap`);
  }
  // Squirrel.Mac can only install from a zip, so each architecture needs one.
  const zips = ["arm64", "x64"].map((arch) => `Eta-${expected}-mac-${arch}.zip`);
  for (const zip of zips) if (!files.has(zip)) throw new Error(`Update feed is missing ${zip}`);
  const feed: UpdateFeed = {
    version: expected,
    files: [...files.values()],
    // Legacy single-file fields predate `files`; current updaters choose by architecture.
    path: zips[0]!,
    sha512: files.get(zips[0]!)!.sha512,
    releaseDate: feeds
      .map((feed) => feed.releaseDate)
      .toSorted()
      .at(-1)!,
  };
  const path = join(directory, "latest-mac.yml");
  writeFileSync(path, stringify(feed));
  return [...uploads.filter((upload) => !upload.endsWith(".dmg")), path];
}

/** Publish only complete drafts; reruns leave an already published release unchanged. */
export function publishRelease(root: string, tag: string, directory: string, repository: string) {
  const revision = validateRelease(root, tag);
  const gh = (args: string[]) => command(root, "gh", args);
  const releases = (
    JSON.parse(
      gh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
    ) as PublishedRelease[][]
  ).flat();
  const existing = releases.find((release) => release.tag_name === tag);
  if (existing && !existing.draft) {
    console.log(`${tag} is already published; nothing was changed.`);
    return;
  }
  const previous = previousRelease(root, tag, releases);
  const installers = installerChecksums(directory, tag);
  const updates = updateFeed(directory, tag);
  const signed = process.env.ETA_SIGNED_RELEASE === "1";
  const checksumText = installers.map(({ name, digest }) => `${digest}  ${name}`).join("\n") + "\n";
  const checksumsPath = join(directory, "SHA256SUMS.txt");
  const notesPath = join(directory, "release-notes.md");
  const signing = signed
    ? "本版本使用 Apple Developer ID 签名并完成公证，已安装的签名版 Eta 会通过自动更新收到此版本。"
    : "本版本使用 ad-hoc 签名，未经过 Apple Developer ID 签名或公证。若 macOS 阻止首次打开，请确认下载来源后，在「系统设置 → 隐私与安全性」中允许打开。";
  const notes =
    releaseNotes(root, tag, repository, previous) +
    `\n### macOS 安装包\n\n- Apple Silicon：\`${installers[0]!.name}\`\n- Intel：\`${installers[1]!.name}\`\n\n打开对应 DMG，将 Eta 拖入 Applications 文件夹。\n\n${signing}\n\n### SHA-256\n\n\`\`\`text\n${checksumText}\`\`\`\n\n源码提交：\`${revision}\`。\n`;
  writeFileSync(checksumsPath, checksumText);
  writeFileSync(notesPath, notes);
  if (existing) gh(["release", "edit", tag, "--repo", repository, "--notes-file", notesPath]);
  else
    gh([
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--draft",
      "--title",
      `Eta ${tag}`,
      "--notes-file",
      notesPath,
    ]);
  gh([
    "release",
    "upload",
    tag,
    "--repo",
    repository,
    "--clobber",
    ...installers.map(({ path }) => path),
    ...updates,
    checksumsPath,
  ]);
  const uploaded = JSON.parse(
    gh(["release", "view", tag, "--repo", repository, "--json", "assets"]),
  ) as {
    assets: { name: string; digest: string; state: string }[];
  };
  for (const path of [...installers.map(({ path }) => path), ...updates]) {
    const name = path.slice(directory.length + 1);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    const asset = uploaded.assets.find((asset) => asset.name === name);
    if (asset?.state !== "uploaded" || asset.digest !== `sha256:${digest}`)
      throw new Error(`Uploaded installer checksum mismatch: ${name}`);
  }
  const newerPublished = releases.some(
    (release) =>
      !release.draft &&
      !release.prerelease &&
      versionPattern.test(release.tag_name) &&
      olderThan(tag, release.tag_name),
  );
  console.log(
    gh([
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--draft=false",
      newerPublished ? "--latest=false" : "--latest",
    ]),
  );
}

if (import.meta.main) {
  const [mode, tag, directory] = process.argv.slice(2);
  if (!tag)
    throw new Error(
      "Usage: node scripts/desktop-release.ts validate|publish vX.Y.Z [installer-directory]",
    );
  if (mode === "validate") console.log(`Validated ${tag}: ${validateRelease(process.cwd(), tag)}`);
  else if (mode === "publish" && directory && process.env.GITHUB_REPOSITORY)
    publishRelease(process.cwd(), tag, resolve(directory), process.env.GITHUB_REPOSITORY);
  else throw new Error("Publish requires an installer directory and GITHUB_REPOSITORY.");
}
