import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

async function repository(name = "repo") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "eta-git-")));
  directories.push(directory);
  const root = join(directory, name);
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

test.skipIf(process.platform === "win32")(
  "repository location preserves embedded and trailing newlines in paths",
  async () => {
    const { root } = await repository(
      "repo" + String.fromCharCode(10) + "root" + String.fromCharCode(10),
    );
    const subdirectory = join(root, "app" + String.fromCharCode(10) + "source");
    await mkdir(subdirectory);
    expect(await inspectRepository(subdirectory, "newline-path")).toMatchObject({
      status: "ready",
      root,
      gitDir: join(root, ".git"),
      commonDir: join(root, ".git"),
      prefix: "app" + String.fromCharCode(10) + "source",
      head: { kind: "unborn", name: "main" },
    });
  },
);

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

test.each(["index", "remote"] as const)(
  "failed %s reads are unavailable rather than a ready snapshot, and recover after repair",
  async (fault) => {
    const { directory, root } = await committed();
    await git(root, "remote", "add", "origin", "https://github.com/eta/app.git");
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
    expect(await core.gitRepository(workspace.id)).toMatchObject({
      status: "ready",
      changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
    await writeFile(join(root, "README.md"), "world\n");
    await writeFile(join(root, "untracked.txt"), "keep me\n");
    const index = await readFile(join(root, ".git", "index"));
    if (fault === "index") await writeFile(join(root, ".git", "index"), "broken index");
    else await git(root, "config", "remote.origin.fetch", "not a refspec");
    try {
      await expect(
        git(root, ...(fault === "index" ? ["status", "--porcelain=v1", "-z"] : ["remote", "-v"])),
      ).rejects.toMatchObject({ code: 128 });
      const failed = await core.gitRepository(workspace.id);
      expect(failed).toMatchObject({
        status: "unavailable",
        workspaceId: workspace.id,
        reason: "error",
      });
      expect(failed).not.toHaveProperty("changes");
      expect(failed).not.toHaveProperty("remotes");
      expect(failed).not.toHaveProperty("github");
    } finally {
      if (fault === "index") await writeFile(join(root, ".git", "index"), index);
      else await git(root, "config", "--unset", "remote.origin.fetch");
    }
    expect(await core.gitRepository(workspace.id)).toMatchObject({
      status: "ready",
      changes: { staged: 0, unstaged: 1, untracked: 1, conflicted: 0 },
      github: { selection: { owner: "eta", repo: "app" } },
    });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("world\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("keep me\n");
  },
);

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

// All userinfo here is synthetic. Build the URLs at runtime instead of storing
// literal Basic Auth URLs that secret scanners cannot distinguish from real ones.
const syntheticRemoteUrl = (scheme: string, userinfo: string, rest: string) =>
  [scheme, "://", userinfo, "@", rest].join("");

test.each([
  {
    url: syntheticRemoteUrl("https", "audit@example.com:fixture-secret", "github.com/eta/app.git"),
    redacted: "https://github.com/eta/app.git",
  },
  {
    url: syntheticRemoteUrl(
      "ssh",
      "audit@example.com:fixture-secret",
      "git.example.org/eta/app.git",
    ),
    redacted: "ssh://git.example.org/eta/app.git",
  },
])("public Git remote DTO removes all userinfo from $url", async ({ url, redacted }) => {
  const { directory, root } = await committed();
  await git(root, "remote", "add", "origin", url);
  expect((await git(root, "remote", "get-url", "origin")).stdout.trim()).toBe(url);
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
  const info = await core.gitRepository(workspace.id);
  expect(info).toMatchObject({ status: "ready", remotes: [{ name: "origin", url: redacted }] });
  expect(JSON.stringify(info)).not.toContain("fixture-secret");
  // Redaction is a DTO boundary, not permission to rewrite the user's transport configuration.
  expect((await git(root, "remote", "get-url", "origin")).stdout.trim()).toBe(url);
});

test.each([
  {
    url: syntheticRemoteUrl(
      "https",
      "user:p@fixture-secret",
      "[::1]:8443/audit@app.git?contact=audit@example.com#user@ref",
    ),
    redacted: "https://[::1]:8443/audit@app.git?contact=audit@example.com#user@ref",
  },
  {
    url: syntheticRemoteUrl(
      "https",
      "audit%40example.com:fixture-secret",
      "github.com/eta/app.git",
    ),
    redacted: "https://github.com/eta/app.git",
  },
])("remote redaction retains the URL after the authority in $url", ({ url, redacted }) => {
  expect(redactRemoteUrl(url)).toBe(redacted);
});

test.each([
  "https://git.example.org?contact=audit@example.com",
  "https://git.example.org#contact=audit@example.com",
  "https://git.example.org/eta/audit@app.git",
  "git@git.example.org:eta/app.git",
  "/local/audit@app.git",
])("remote redaction preserves non-userinfo @ in %s", (url) => {
  expect(redactRemoteUrl(url)).toBe(url);
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

test("real branches ending in HEAD remain visible while remote symbolic aliases are hidden", async () => {
  const { directory, root } = await committed();
  await git(root, "branch", "topic/HEAD");
  await git(root, "update-ref", "refs/remotes/origin/feature/HEAD", "HEAD");
  await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature/HEAD");
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
  const branches = await core.gitBranches(workspace.id);
  expect(branches.map((branch) => branch.name).sort()).toEqual([
    "main",
    "origin/feature/HEAD",
    "topic/HEAD",
  ]);
  expect(branches.find((branch) => branch.name === "topic/HEAD")).toMatchObject({ kind: "local" });
  expect(branches.find((branch) => branch.name === "origin/feature/HEAD")).toMatchObject({
    kind: "remote",
  });
  const created = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: workspace.id,
    branch: { kind: "existing", name: "topic/HEAD" },
    requestId: "existing-head-suffix",
  });
  expect(created).toMatchObject({ status: "ready", branch: "topic/HEAD", createdBranch: false });
  expect(
    (await core.gitBranches(workspace.id)).find((branch) => branch.name === "topic/HEAD"),
  ).toMatchObject({ checkedOutAt: created.path });
});

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
