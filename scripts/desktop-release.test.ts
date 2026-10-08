import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { parse, stringify } from "yaml";
import {
  installerChecksums,
  previousRelease,
  releaseNotes,
  updateFeed,
  validateRelease,
} from "./desktop-release.ts";
import type { PublishedRelease } from "./desktop-release.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "eta-release-test-"));
  directories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Eta release test");
  git(root, "config", "user.email", "eta-release@example.invalid");
  git(root, "config", "core.hooksPath", "/dev/null");
  mkdirSync(join(root, "apps/desktop"), { recursive: true });
  const commit = (message: string) => {
    git(root, "add", ".");
    git(root, "commit", "--allow-empty", "-m", message);
    return git(root, "rev-parse", "HEAD");
  };
  const setVersion = (value: string) => {
    for (const path of ["package.json", "apps/desktop/package.json"])
      writeFileSync(join(root, path), JSON.stringify({ version: value }));
  };
  setVersion("0.0.1");
  commit("feat: 初始版本");
  git(root, "tag", "v0.0.1");
  commit("fix(chat): 修复等待状态");
  git(root, "tag", "v0.0.2");
  commit("feat(settings): 添加外观预览");
  setVersion("0.0.3");
  commit("chore(release): bump desktop version to 0.0.3");
  git(root, "tag", "-a", "v0.0.3", "-m", "Eta v0.0.3");
  const release = (tag: string, publishedAt = "2026-10-01T00:00:00Z"): PublishedRelease => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: publishedAt,
  });
  return { root, commit, setVersion, release };
}

test("release notes use the last published ancestor, including commits behind unpublished tags", () => {
  const { root, release } = setup();
  const previous = previousRelease(root, "v0.0.3", [release("v0.0.1")]);
  assert.equal(previous, "v0.0.1");
  const notes = releaseNotes(root, "v0.0.3", "owner/eta", previous);
  assert.match(notes, /### 修复\n\n- chat：修复等待状态/);
  assert.match(notes, /### 新增功能\n\n- settings：添加外观预览/);
  assert.ok(!notes.includes("初始版本"));
  assert.ok(!notes.includes("bump desktop version"));
  assert.match(notes, /compare\/v0\.0\.1\.\.\.v0\.0\.3/);
});

test("drafts, prereleases, newer versions and unrelated branches cannot become the baseline", () => {
  const { root, commit, release } = setup();
  git(root, "checkout", "-b", "other", "v0.0.1");
  commit("fix: unrelated branch");
  git(root, "tag", "v0.0.0");
  git(root, "checkout", "main");
  const candidates = [
    release("v0.0.1"),
    { ...release("v0.0.2", "2026-10-02"), draft: true },
    { ...release("v0.0.2", "2026-10-03"), prerelease: true },
    release("v0.0.0", "2026-10-04"),
    release("v0.0.3", "2026-10-05"),
    release("v0.0.10", "2026-10-06"),
  ];
  assert.equal(previousRelease(root, "v0.0.3", candidates), "v0.0.1");
  assert.equal(
    previousRelease(root, "v0.0.3", [...candidates, release("v0.0.2", "2026-10-07")]),
    "v0.0.2",
  );
  git(root, "tag", "v0.0.10");
  assert.equal(previousRelease(root, "v0.0.10", [release("v0.0.3", "2026-10-08")]), "v0.0.3");
});

test("missing published history fails instead of silently generating a partial changelog", () => {
  const { root, release } = setup();
  git(root, "tag", "-d", "v0.0.1");
  assert.throws(() => previousRelease(root, "v0.0.3", [release("v0.0.1")]));
});

test("first-release notes preserve breaking changes and escape commit Markdown", () => {
  const { root, commit } = setup();
  commit("feat(api)!: change <schema> [format]");
  commit("fix: rename field\n\nBREAKING CHANGE: removed the old field");
  commit("feat(comment): explain startup");
  git(root, "tag", "v0.0.4");
  const notes = releaseNotes(root, "v0.0.4", "owner/eta");
  assert.match(notes, /### 不兼容变更/);
  assert.ok(notes.includes("change \\<schema\\> \\[format\\]"));
  assert.match(notes, /### 维护\n\n- comment：explain startup/);
  assert.match(notes, /初始版本/);
  assert.match(notes, /commits\/v0\.0\.4/);
});

test("tags must name the checked-out source and match both manifest versions", () => {
  const { root } = setup();
  assert.equal(validateRelease(root, "v0.0.3"), git(root, "rev-parse", "HEAD"));
  assert.throws(() => validateRelease(root, "v0.0.03"), /stable version/);
  assert.throws(() => validateRelease(root, "v0.0.3-beta.1"), /stable version/);
  writeFileSync(join(root, "apps/desktop/package.json"), '{"version":"0.0.2"}');
  assert.throws(() => validateRelease(root, "v0.0.3"), /apps\/desktop\/package.json version/);
  git(root, "checkout", "--", "apps/desktop/package.json");
  git(root, "tag", "-f", "v0.0.3", "v0.0.1");
  assert.throws(() => validateRelease(root, "v0.0.3"), /Check out/);
});

test("both nonempty versioned installers are required and produce accurate checksums", () => {
  const { root } = setup();
  assert.throws(() => installerChecksums(root, "v0.0.3"), /ENOENT/);
  writeFileSync(join(root, "Eta-0.0.3-mac-arm64.dmg"), "arm64 installer");
  writeFileSync(join(root, "Eta-0.0.3-mac-x64.dmg"), "");
  assert.throws(() => installerChecksums(root, "v0.0.3"), /Empty installer/);
  writeFileSync(join(root, "Eta-0.0.3-mac-x64.dmg"), "x64 installer");
  assert.deepEqual(
    installerChecksums(root, "v0.0.3").map(({ name, digest }) => ({ name, digest })),
    [
      {
        name: "Eta-0.0.3-mac-arm64.dmg",
        digest: createHash("sha256").update("arm64 installer").digest("hex"),
      },
      {
        name: "Eta-0.0.3-mac-x64.dmg",
        digest: createHash("sha256").update("x64 installer").digest("hex"),
      },
    ],
  );
});

/** Writes one architecture's zip and dmg with the latest-mac-<arch>.yml electron-builder emits. */
function writeArchitecture(directory: string, arch: string, version = "0.0.3") {
  const files = ["zip", "dmg"].map((extension) => {
    const url = `Eta-${version}-mac-${arch}.${extension}`;
    const data = `${extension} ${arch}`;
    writeFileSync(join(directory, url), data);
    return { url, sha512: createHash("sha512").update(data).digest("base64"), size: data.length };
  });
  // electron-builder can also emit a dmg blockmap; the release must leave it out.
  for (const extension of ["zip", "dmg"])
    writeFileSync(
      join(directory, `Eta-${version}-mac-${arch}.${extension}.blockmap`),
      `blockmap ${arch}`,
    );
  writeFileSync(
    join(directory, `latest-mac-${arch}.yml`),
    stringify({
      version,
      files,
      path: files[0]!.url,
      sha512: files[0]!.sha512,
      releaseDate: arch === "x64" ? "2026-10-08T03:00:00.000Z" : "2026-10-08T02:00:00.000Z",
    }),
  );
}

test("per-architecture update feeds merge into one feed that lists every verified zip", () => {
  const { root } = setup();
  writeArchitecture(root, "arm64");
  assert.throws(() => updateFeed(root, "v0.0.3"), /missing Eta-0\.0\.3-mac-x64\.zip/);
  writeArchitecture(root, "x64");
  const uploads = updateFeed(root, "v0.0.3").map((path) => path.slice(root.length + 1));
  assert.deepEqual(uploads.toSorted(), [
    "Eta-0.0.3-mac-arm64.zip",
    "Eta-0.0.3-mac-arm64.zip.blockmap",
    "Eta-0.0.3-mac-x64.zip",
    "Eta-0.0.3-mac-x64.zip.blockmap",
    "latest-mac.yml",
  ]);
  const feed = parse(readFileSync(join(root, "latest-mac.yml"), "utf8")) as {
    version: string;
    files: { url: string }[];
    path: string;
    releaseDate: string;
  };
  assert.equal(feed.version, "0.0.3");
  assert.equal(feed.files.length, 4);
  assert.equal(feed.path, "Eta-0.0.3-mac-arm64.zip");
  assert.equal(feed.releaseDate, "2026-10-08T03:00:00.000Z");
});

test("an update feed for another version or with a corrupted zip is rejected", () => {
  const { root } = setup();
  writeArchitecture(root, "arm64");
  writeArchitecture(root, "x64", "0.0.2");
  assert.throws(() => updateFeed(root, "v0.0.3"), /version 0\.0\.2 does not match v0\.0\.3/);
  writeArchitecture(root, "x64");
  writeFileSync(join(root, "Eta-0.0.3-mac-x64.zip"), "tampered");
  assert.throws(() => updateFeed(root, "v0.0.3"), /checksum mismatch: Eta-0\.0\.3-mac-x64\.zip/);
});

function githubFixture(root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const file = process.env.GH_TEST_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const output = value => console.log(JSON.stringify(value));
if (args[0] === "api") output([[...state.previous, ...(state.current ? [state.current] : [])]]);
else if (args[1] === "create") state.current = {tag_name: args[2], draft: true, body: fs.readFileSync(args[args.indexOf("--notes-file")+1], "utf8"), assets: []};
else if (args[1] === "edit" && args.includes("--notes-file")) state.current.body = fs.readFileSync(args[args.indexOf("--notes-file")+1], "utf8");
else if (args[1] === "upload") state.current.assets = args.slice(args.indexOf("--clobber")+1).map(file => ({name: path.basename(file), state: "uploaded", digest: "sha256:"+crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}));
else if (args[1] === "view") output({assets: state.current.assets.map(asset => state.corrupt && asset.name.endsWith("arm64.dmg") ? {...asset, digest: "wrong"} : asset)});
else if (args.includes("--draft=false")) { state.current.draft = false; state.current.latest = args.includes("--latest"); }
else throw new Error("Unexpected GitHub command");
fs.writeFileSync(file, JSON.stringify(state));
`,
    { mode: 0o755 },
  );
  const statePath = join(root, "github.json");
  const assets = join(root, "assets");
  mkdirSync(assets);
  for (const arch of ["arm64", "x64"]) writeArchitecture(assets, arch);
  const publish = () =>
    execFileSync(
      process.execPath,
      [resolve("scripts/desktop-release.ts"), "publish", "v0.0.3", assets],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TEST_STATE: statePath,
          GITHUB_REPOSITORY: "owner/eta",
          ETA_SIGNED_RELEASE: "0",
        },
      },
    );
  return { statePath, assets, publish };
}

test("publishing creates a complete release and rerunning preserves published edits", () => {
  const { root, release } = setup();
  const { statePath, assets, publish } = githubFixture(root);
  writeFileSync(statePath, JSON.stringify({ previous: [release("v0.0.1")] }));
  publish();
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    current: { draft: boolean; body: string; assets: { name: string }[] };
  };
  assert.equal(state.current.draft, false);
  assert.match(state.current.body, /修复等待状态/);
  assert.match(state.current.body, /ad-hoc 签名/);
  assert.deepEqual(state.current.assets.map((asset) => asset.name).toSorted(), [
    "Eta-0.0.3-mac-arm64.dmg",
    "Eta-0.0.3-mac-arm64.zip",
    "Eta-0.0.3-mac-arm64.zip.blockmap",
    "Eta-0.0.3-mac-x64.dmg",
    "Eta-0.0.3-mac-x64.zip",
    "Eta-0.0.3-mac-x64.zip.blockmap",
    "SHA256SUMS.txt",
    "latest-mac.yml",
  ]);
  state.current.body = "Maintainer edited release notes";
  writeFileSync(statePath, JSON.stringify(state));
  rmSync(assets, { recursive: true });
  const before = readFileSync(statePath, "utf8");
  assert.match(publish(), /already published/);
  assert.equal(readFileSync(statePath, "utf8"), before);
});

test("a corrupted upload stays a draft; retrying an older version preserves the newer Latest release", () => {
  const { root, release } = setup();
  const { statePath, publish } = githubFixture(root);
  writeFileSync(
    statePath,
    JSON.stringify({ previous: [release("v0.0.1"), release("v0.0.10")], corrupt: true }),
  );
  assert.throws(publish, /checksum mismatch/);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    corrupt: boolean;
    current: { draft: boolean; latest: boolean };
  };
  assert.equal(state.current.draft, true);
  state.corrupt = false;
  writeFileSync(statePath, JSON.stringify(state));
  publish();
  assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as typeof state).current.draft, false);
  assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as typeof state).current.latest, false);
});
