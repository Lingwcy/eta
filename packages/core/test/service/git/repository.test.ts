import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { createModels } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore } from "../../../src/client.ts";
import type { CoreClient } from "../../../src/client.ts";
import { inspectRepository, parseStatus, selectGitHub } from "../../../src/service/git/index.ts";
import { parseGitHubRemote, redactRemoteUrl } from "../../../src/platform/git.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args], { cwd });

const directories: string[] = [];
const clients: CoreClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function repository() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "eta-git-")));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(root);
  await git(root, "init", "-q", "-b", "main");
  return { directory, root };
}

async function committed() {
  const value = await repository();
  await writeFile(join(value.root, "README.md"), "hello\n");
  await git(value.root, "add", ".");
  await git(value.root, "commit", "-q", "-m", "init");
  return value;
}

test("plain directories are not repositories and missing ones are unavailable", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "eta-git-")));
  directories.push(directory);
  expect(await inspectRepository(directory, "w")).toEqual({
    status: "not-repository",
    workspaceId: "w",
  });
  expect(await inspectRepository(join(directory, "gone"), "w")).toMatchObject({
    status: "unavailable",
    reason: "directory-missing",
  });
});

test("an empty repository reports an unborn branch and untracked files", async () => {
  const { root } = await repository();
  await writeFile(join(root, "new.txt"), "x");
  expect(await inspectRepository(root, "w")).toMatchObject({
    status: "ready",
    root,
    head: { kind: "unborn", name: "main" },
    linkedWorktree: false,
    changes: { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 },
  });
});

test("linked worktrees and subdirectories share the main repository's common directory", async () => {
  const { directory, root } = await committed();
  await mkdir(join(root, "packages", "app"), { recursive: true });
  await writeFile(join(root, "packages", "app", "index.ts"), "");
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "app");
  const linked = join(directory, "linked");
  await git(root, "worktree", "add", "-q", "-b", "feature", linked);
  const main = await inspectRepository(root, "main");
  const worktree = await inspectRepository(join(linked, "packages", "app"), "linked");
  if (main.status !== "ready" || worktree.status !== "ready") throw new Error("not ready");
  expect(worktree).toMatchObject({
    root: linked,
    prefix: "packages/app",
    linkedWorktree: true,
    commonDir: main.commonDir,
    head: { kind: "branch", name: "feature" },
  });
  expect(worktree.gitDir).toBe(join(main.commonDir, "worktrees", "linked"));
});

test("status counts staged, unstaged, untracked and conflicted entries", () => {
  expect(
    parseStatus(["M  a", " M b", "MM c", "?? d", "UU e", "R  new", "old", ""].join("\0")),
  ).toEqual({ staged: 3, unstaged: 2, untracked: 1, conflicted: 1 });
});

test("GitHub remotes are recognised without leaking credentials", () => {
  for (const url of [
    "https://github.com/eta/app.git",
    "https://token@github.com/eta/app",
    "git@github.com:eta/app.git",
    "ssh://git@github.com/eta/app.git",
  ])
    expect(parseGitHubRemote(url)).toEqual({ host: "github.com", owner: "eta", repo: "app" });
  expect(parseGitHubRemote("https://gitlab.com/eta/app.git")).toBeUndefined();
  expect(parseGitHubRemote("git@work-alias:eta/app.git")).toBeUndefined();
  expect(redactRemoteUrl("https://user:secret@github.com/eta/app.git")).toBe(
    "https://github.com/eta/app.git",
  );
});

test("remote selection prefers a saved choice, then origin, then the only GitHub remote", () => {
  const remote = (name: string, owner: string) => ({
    name,
    url: `https://github.com/${owner}/app.git`,
    github: { host: "github.com", owner, repo: "app" },
  });
  const fork = [remote("origin", "me"), remote("upstream", "eta")];
  expect(selectGitHub(fork, undefined)?.selection).toMatchObject({ remote: "origin", owner: "me" });
  expect(selectGitHub(fork, "upstream")?.selection).toMatchObject({
    remote: "upstream",
    reason: "saved",
  });
  expect(selectGitHub(fork, "gone")).toMatchObject({
    savedInvalid: true,
    selection: { remote: "origin" },
  });
  expect(selectGitHub([remote("a", "x"), remote("b", "y")], undefined)?.selection).toBeUndefined();
  expect(selectGitHub([remote("mine", "x")], undefined)?.selection).toMatchObject({
    reason: "only",
  });
  expect(
    selectGitHub([{ name: "origin", url: "https://gitlab.com/x/y" }], undefined),
  ).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "branch listing preserves a linked worktree path containing a newline",
  async () => {
    const { directory, root } = await committed();
    const linked = join(directory, "linked" + String.fromCharCode(10) + "checkout");
    await git(root, "worktree", "add", "-q", "-b", "feature", linked);
    const core = await createCore({
      dataRoot: join(directory, "data"),
      home: directory,
      models: createModels(),
      settings: {
        read: Effect.succeed({ defaultThinkingLevel: "off" }),
        subscribe: () => () => {},
      },
      environment: { userAgent: "eta-core-test", shutdown: "preserve" },
    });
    clients.push(core);
    const project = await core.registerProject(root);
    const workspace = (await core.workspaces(project.id))[0]!;
    const branches = await core.gitBranches(workspace.id);
    expect(branches.map((branch) => branch.name).sort()).toEqual(["feature", "main"]);
    expect(branches.find((branch) => branch.name === "feature")).toMatchObject({
      checkedOutAt: linked,
      current: false,
    });
    // The create path consumes this protocol too: preserve occupancy and don't invent refs.
    await expect(
      core.createWorktree({
        projectId: project.id,
        baseWorkspaceId: workspace.id,
        branch: { kind: "existing", name: "main" },
        requestId: "occupied-main",
      }),
    ).rejects.toMatchObject({ code: "Busy" });
    await expect(
      core.createWorktree({
        projectId: project.id,
        baseWorkspaceId: workspace.id,
        branch: { kind: "new", name: "checkout" },
        requestId: "not-a-path-fragment",
      }),
    ).resolves.toMatchObject({ status: "ready", branch: "checkout" });
  },
);

test("host-side inspection never runs a repository's fsmonitor", async () => {
  const { directory, root } = await committed();
  const marker = join(directory, "fsmonitor-ran");
  const script = join(directory, "monitor.sh");
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await git(root, "config", "core.fsmonitor", script);
  await writeFile(join(root, "README.md"), "changed\n");
  expect(await inspectRepository(root, "w")).toMatchObject({ changes: { unstaged: 1 } });
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

test("the client exposes branches with worktree occupancy and saves the GitHub remote", async () => {
  const { directory, root } = await committed();
  await git(root, "remote", "add", "origin", "https://github.com/me/app.git");
  await git(root, "remote", "add", "upstream", "git@github.com:eta/app.git");
  await git(root, "worktree", "add", "-q", "-b", "busy", join(directory, "busy"));
  const core = await createCore({
    dataRoot: join(directory, "data"),
    home: directory,
    models: createModels(),
    settings: { read: Effect.succeed({ defaultThinkingLevel: "off" }), subscribe: () => () => {} },
    environment: { userAgent: "eta-core-test", shutdown: "preserve" },
  });
  clients.push(core);
  const project = await core.registerProject(root);
  const workspace = (await core.workspaces(project.id))[0]!;
  expect(await core.gitBranches(workspace.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "main", kind: "local", current: true }),
      expect.objectContaining({ name: "busy", checkedOutAt: join(directory, "busy") }),
    ]),
  );
  expect(await core.gitRepository(workspace.id)).toMatchObject({
    github: {
      selection: { remote: "origin", reason: "origin" },
      candidates: ["origin", "upstream"],
    },
  });
  expect(await core.selectGitHubRemote(project.id, "upstream")).toMatchObject({
    github: { selection: { remote: "upstream", owner: "eta", reason: "saved" } },
  });
  await expect(core.selectGitHubRemote(project.id, "missing")).rejects.toMatchObject({
    code: "InvalidInput",
  });
});
