import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { syncAgent } from "./sync-agent.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function file(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function commit(root: string, message: string) {
  git(root, "add", ".");
  git(root, "commit", "-m", message);
}
function repo(path: string) {
  mkdirSync(path);
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Eta sync test");
  git(path, "config", "user.email", "eta-test@example.invalid");
  git(path, "config", "core.hooksPath", "/dev/null");
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "eta-agent-sync-"));
  directories.push(directory);
  const upstream = join(directory, "upstream");
  const root = join(directory, "eta");
  repo(upstream);
  repo(root);
  file(upstream, "packages/durable/package.json", '{\n  "name": "@earendil-works/pi-durable"\n}\n');
  file(upstream, "packages/durable/src/index.ts", 'export const answer = "baseline";\n');
  file(upstream, "packages/other/index.ts", "not imported\n");
  commit(upstream, "upstream baseline");
  file(root, "packages/agent/package.json", '{\n  "name": "@eta/agent"\n}\n');
  file(root, "packages/agent/src/index.ts", 'export const answer = "baseline";\n');
  file(root, "README.md", "Eta\n");
  commit(root, "existing copy");
  const baseline = git(upstream, "rev-parse", "HEAD");
  const options = { root, repository: upstream, log: () => {} };
  return { root, upstream, baseline, options };
}

test("adoption preserves the exact workspace tree and supports updates and repeated syncs", () => {
  const { root, upstream, baseline, options } = setup();
  const before = git(root, "rev-parse", "HEAD^{tree}");
  syncAgent({ ...options, initialize: true, ref: baseline });
  assert.equal(git(root, "rev-parse", "HEAD^{tree}"), before);
  assert.equal(git(root, "status", "--porcelain"), "");
  const adopted = git(root, "rev-parse", "HEAD");
  assert.equal(syncAgent(options).changed, false);
  assert.equal(git(root, "rev-parse", "HEAD"), adopted);
  file(upstream, "packages/durable/src/index.ts", 'export const answer = "updated";\n');
  commit(upstream, "update durable");
  assert.equal(syncAgent(options).changed, true);
  assert.match(readFileSync(join(root, "packages/agent/src/index.ts"), "utf8"), /updated/);
  assert.match(readFileSync(join(root, "packages/agent/package.json"), "utf8"), /@eta\/agent/);
  assert.equal(git(root, "ls-tree", "HEAD", "packages/other"), "");
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(syncAgent(options).changed, false);
});

test("dry runs fetch and plan without changing files or history", () => {
  const { root, baseline, options } = setup();
  const before = git(root, "rev-parse", "HEAD");
  syncAgent({ ...options, initialize: true, ref: baseline, dryRun: true });
  assert.equal(git(root, "rev-parse", "HEAD"), before);
  assert.equal(git(root, "status", "--porcelain"), "");
  syncAgent({ ...options, initialize: true, ref: baseline });
  const adopted = git(root, "rev-parse", "HEAD");
  file(root, "README.md", "uncommitted work\n");
  syncAgent({ ...options, dryRun: true });
  assert.equal(git(root, "rev-parse", "HEAD"), adopted);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "uncommitted work\n");
});

test("dirty workspaces and initialization without a pinned baseline are rejected", () => {
  const { root, baseline, options } = setup();
  assert.throws(() => syncAgent({ ...options, initialize: true }), /explicit baseline/);
  assert.throws(() => syncAgent(options), /no subtree baseline/);
  file(root, "README.md", "local changes\n");
  assert.throws(
    () => syncAgent({ ...options, initialize: true, ref: baseline }),
    /Commit or stash/,
  );
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "local changes\n");
});

test("conflicts remain reviewable and merge abort restores local changes", () => {
  const { root, upstream, baseline, options } = setup();
  syncAgent({ ...options, initialize: true, ref: baseline });
  file(root, "packages/agent/src/index.ts", 'export const answer = "local";\n');
  commit(root, "local change");
  const local = git(root, "rev-parse", "HEAD");
  file(upstream, "packages/durable/src/index.ts", 'export const answer = "upstream";\n');
  commit(upstream, "upstream change");
  assert.throws(() => syncAgent(options), /sync stopped/);
  assert.match(git(root, "status", "--porcelain"), /UU packages\/agent\/src\/index.ts/);
  git(root, "merge", "--abort");
  assert.equal(git(root, "rev-parse", "HEAD"), local);
  assert.match(readFileSync(join(root, "packages/agent/src/index.ts"), "utf8"), /local/);
});

test("pinned revisions can be merged after the upstream main branch advances", () => {
  const { root, upstream, baseline, options } = setup();
  syncAgent({ ...options, initialize: true, ref: baseline });
  file(upstream, "packages/durable/src/index.ts", 'export const answer = "selected";\n');
  commit(upstream, "selected revision");
  const selected = git(upstream, "rev-parse", "HEAD");
  file(upstream, "packages/durable/src/index.ts", 'export const answer = "latest";\n');
  commit(upstream, "latest revision");
  syncAgent({ ...options, ref: selected });
  assert.match(readFileSync(join(root, "packages/agent/src/index.ts"), "utf8"), /selected/);
});

test("an ordinary clone can recreate the cache and merge a pinned older revision", () => {
  const { root, upstream, baseline, options } = setup();
  syncAgent({ ...options, initialize: true, ref: baseline });
  file(upstream, "packages/durable/src/index.ts", 'export const answer = "new version";\n');
  commit(upstream, "new upstream version");
  syncAgent(options);
  const clone = join(dirname(root), "clone");
  git(dirname(root), "clone", "--no-local", root, clone);
  git(clone, "config", "user.name", "Eta sync test");
  git(clone, "config", "user.email", "eta-test@example.invalid");
  git(clone, "config", "core.hooksPath", "/dev/null");
  syncAgent({ ...options, root: clone, ref: baseline });
  assert.match(readFileSync(join(clone, "packages/agent/src/index.ts"), "utf8"), /baseline/);
  assert.match(readFileSync(join(clone, "packages/agent/package.json"), "utf8"), /@eta\/agent/);
  assert.equal(git(clone, "status", "--porcelain"), "");
});

test("upstream manifest updates preserve Eta's package name and local dependencies without recurring conflicts", () => {
  const { root, upstream, baseline, options } = setup();
  syncAgent({ ...options, initialize: true, ref: baseline });
  file(
    root,
    "packages/agent/package.json",
    JSON.stringify({ name: "@eta/agent", devDependencies: { typescript: "catalog:" } }, null, 2) +
      "\n",
  );
  commit(root, "Eta build integration");
  for (const version of ["1.0.1", "1.0.2"]) {
    file(
      upstream,
      "packages/durable/package.json",
      JSON.stringify(
        { name: "@earendil-works/pi-durable", version, dependencies: { runtime: version } },
        null,
        "\t",
      ) + "\n",
    );
    commit(upstream, `upstream ${version}`);
    syncAgent(options);
    const manifest = JSON.parse(readFileSync(join(root, "packages/agent/package.json"), "utf8"));
    assert.equal(manifest.name, "@eta/agent");
    assert.equal(manifest.version, version);
    assert.equal(manifest.devDependencies.typescript, "catalog:");
    assert.equal(manifest.dependencies.runtime, version);
    assert.equal(git(root, "status", "--porcelain"), "");
  }
  assert.equal(syncAgent(options).changed, false);
});

test("conflicting edits to the same manifest field remain available for manual resolution", () => {
  const { root, upstream, baseline, options } = setup();
  syncAgent({ ...options, initialize: true, ref: baseline });
  file(root, "packages/agent/package.json", '{"name":"@eta/agent","version":"local"}\n');
  commit(root, "local version");
  file(
    upstream,
    "packages/durable/package.json",
    '{"name":"@earendil-works/pi-durable","version":"remote"}\n',
  );
  commit(upstream, "remote version");
  assert.throws(() => syncAgent(options), /sync stopped/);
  assert.match(git(root, "status", "--porcelain"), /UU packages\/agent\/package.json/);
});
