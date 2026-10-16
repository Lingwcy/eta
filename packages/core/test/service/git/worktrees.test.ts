import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore } from "../../../src/client.ts";
import type { CoreClient } from "../../../src/client.ts";
import { worktreeBranchName } from "../../../src/shared/git.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args], { cwd }))
    .stdout;

const directories: string[] = [];
const clients: CoreClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(
  options: { empty?: boolean; subdirectory?: boolean; defaultRoot?: boolean } = {},
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "eta-worktrees-")));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(join(root, "app"), { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  if (!options.empty) {
    await writeFile(join(root, "README.md"), "hello\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "init");
    await writeFile(join(root, "app", "index.ts"), "export {};\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "app");
  }
  const models = createModels();
  const agent = fauxProvider({
    provider: "core-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "core-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  models.setProvider({
    ...agent.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? titles.provider.streamSimple(model, context, options)
        : agent.provider.streamSimple(model, context, options),
  });
  const core = await createCore({
    dataRoot: join(directory, "data"),
    home: directory,
    models,
    settings: {
      read: Effect.succeed({ agentMode: "standard" as const, defaultThinkingLevel: "off" }),
      subscribe: () => () => {},
    },
    environment: {
      userAgent: "eta-core-test",
      shutdown: "preserve",
      ...(options.defaultRoot ? {} : { worktreeRoot: join(directory, "managed") }),
    },
  });
  clients.push(core);
  const project = await core.registerProject(options.subdirectory ? join(root, "app") : root);
  const base = (await core.workspaces(project.id))[0]!;
  return { core, directory, root, project, base, agent };
}

test("a new worktree is an isolated checkout registered as its own workspace", async () => {
  const { core, root, project, base } = await fixture();
  const created = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "new", name: "eta/feature-1" },
    requestId: "create-1",
  });
  expect(created).toMatchObject({
    status: "ready",
    branch: "eta/feature-1",
    createdBranch: true,
    managed: true,
  });
  const workspace = (await core.workspaces(project.id)).find(
    (value) => value.id === created.workspaceId,
  );
  expect(workspace).toMatchObject({ kind: "worktree", cwd: created.cwd });
  await writeFile(join(created.cwd, "only-here.txt"), "x");
  await expect(access(join(root, "only-here.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await core.gitRepository(created.workspaceId!)).toMatchObject({
    linkedWorktree: true,
    head: { kind: "branch", name: "eta/feature-1" },
  });
  const thread = await core.createThread(created.workspaceId!);
  expect(thread.thread.workspaceId).toBe(created.workspaceId);
});

test("creation is idempotent per request and refuses to reuse a request for other parameters", async () => {
  const { core, project, base } = await fixture();
  const input = {
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "new" as const, name: "eta/once" },
    requestId: "same-request",
  };
  const first = await core.createWorktree(input);
  expect(await core.createWorktree(input)).toMatchObject({ workspaceId: first.workspaceId });
  await expect(
    core.createWorktree({ ...input, branch: { kind: "new", name: "eta/other" } }),
  ).rejects.toMatchObject({ code: "InvalidInput" });
  expect(
    (await core.workspaces(project.id)).filter((value) => value.kind === "worktree"),
  ).toHaveLength(1);
});

test("branch rules: new names must be free, existing branches must not be checked out", async () => {
  const { core, root, project, base } = await fixture();
  await git(root, "branch", "existing");
  await expect(
    core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "new", name: "existing" },
      requestId: "dupe",
    }),
  ).rejects.toMatchObject({ code: "InvalidInput" });
  await expect(
    core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "existing", name: "main" },
      requestId: "busy",
    }),
  ).rejects.toMatchObject({ code: "Busy" });
  await expect(
    core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "new", name: "bad..name" },
      requestId: "invalid",
    }),
  ).rejects.toMatchObject({ code: "InvalidInput" });
  expect(
    await core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "existing", name: "existing" },
      requestId: "reuse",
    }),
  ).toMatchObject({ status: "ready", createdBranch: false });
});

test("repositories without a commit cannot create worktrees", async () => {
  const { core, project, base } = await fixture({ empty: true });
  await expect(
    core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "new", name: "eta/x" },
      requestId: "empty",
    }),
  ).rejects.toMatchObject({ message: expect.stringContaining("还没有提交") });
});

test("a subdirectory project keeps its subdirectory and never falls back to the repository root", async () => {
  const { core, root, project, base } = await fixture({ subdirectory: true });
  const created = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "new", name: "eta/sub" },
    requestId: "sub",
  });
  expect(created.cwd).toBe(join(created.path, "app"));
  const first = (await git(root, "rev-list", "--max-parents=0", "HEAD")).trim();
  await expect(
    core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "new", name: "eta/before-app", baseRef: first },
      requestId: "before",
    }),
  ).rejects.toMatchObject({ message: expect.stringContaining("基线中不存在项目目录 app") });
  // Only the main checkout and the first worktree remain; the failed attempt was cleaned up.
  expect((await git(root, "worktree", "list")).trim().split("\n")).toHaveLength(2);
});

test("removal refuses unsaved work, keeps the branch and leaves a readable tombstone", async () => {
  const { core, root, project, base } = await fixture();
  const created = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "new", name: "eta/remove-me" },
    requestId: "to-remove",
  });
  const thread = await core.createThread(created.workspaceId!);
  await writeFile(join(created.cwd, "draft.txt"), "unsaved");
  await expect(core.removeWorktree(created.workspaceId!, "remove-1")).rejects.toMatchObject({
    message: expect.stringContaining("未提交或未跟踪"),
  });
  await rm(join(created.cwd, "draft.txt"));
  await expect(core.removeWorktree(base.id, "remove-root")).rejects.toMatchObject({
    code: "InvalidInput",
  });
  const removed = await core.removeWorktree(created.workspaceId!, "remove-2");
  expect(removed).toMatchObject({ status: "removed", branch: "eta/remove-me" });
  expect(await core.removeWorktree(created.workspaceId!, "remove-2")).toMatchObject({
    status: "removed",
  });
  await expect(access(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await git(root, "branch", "--list", "eta/remove-me")).toContain("eta/remove-me");
  expect((await core.threads(created.workspaceId!)).map((value) => value.id)).toContain(
    thread.thread.id,
  );
  await expect(core.createThread(created.workspaceId!)).rejects.toMatchObject({
    code: "WorkspaceUnavailable",
  });
  const resumed = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "existing", name: "eta/remove-me" },
    continuesWorkspaceId: created.workspaceId!,
    requestId: "resume",
  });
  expect(resumed).toMatchObject({ status: "ready", continues: created.workspaceId });
});

test("reconcile reports external deletion and verifies worktrees registered outside Eta", async () => {
  const { core, directory, root, project, base } = await fixture();
  const created = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "new", name: "eta/gone" },
    requestId: "gone",
  });
  await rm(created.path, { recursive: true, force: true });
  const external = join(directory, "external");
  await git(root, "worktree", "add", "-q", "-b", "outside", external);
  await core.registerWorkspace(project.id, external);
  const stranger = join(directory, "stranger");
  await mkdir(stranger);
  await git(stranger, "init", "-q");
  await core.registerWorkspace(project.id, stranger);
  const results = await core.reconcileWorktrees(project.id);
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ requestId: "gone", status: "needs_reconciliation" }),
      expect.objectContaining({ path: external, managed: false, status: "ready" }),
      expect.objectContaining({ managed: false, status: "needs_reconciliation" }),
    ]),
  );
  const adopted = results.find((value) => value.path === external)!;
  await expect(core.removeWorktree(adopted.workspaceId!, "remove-external")).rejects.toMatchObject({
    message: expect.stringContaining("不是由 Eta 创建的"),
  });
  expect(await readFile(join(external, "README.md"), "utf8")).toBe("hello\n");
});

test("default branch names are valid Git refs", () => {
  expect(worktreeBranchName("Fix login bug!", "a1b2")).toBe("eta/fix-login-bug-a1b2");
  expect(worktreeBranchName("修复登录", "a1b2")).toBe("eta/work-a1b2");
});

test("a removed workspace remains blocked if an unrelated directory appears at its old path", async () => {
  const { core, project, base } = await fixture();
  const created = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "new", name: "eta/tombstone" },
    requestId: "tombstone",
  });
  const thread = await core.createThread(created.workspaceId!);
  await core.removeWorktree(created.workspaceId!, "remove-tombstone");
  await mkdir(created.path);
  expect((await core.openThread(thread.id)).snapshot.blockedReason).toContain("已移除");
  await expect(core.submit(thread.id, "Continue")).rejects.toMatchObject({
    code: "WorkspaceUnavailable",
  });
  await expect(core.createThread(created.workspaceId!)).rejects.toMatchObject({
    code: "WorkspaceUnavailable",
  });
});

test("an unrelated repository registered as a workspace cannot become this project's worktree base", async () => {
  const { core, directory, project } = await fixture();
  const other = join(directory, "unrelated");
  await mkdir(other);
  await git(other, "init", "-q");
  await git(other, "commit", "--allow-empty", "-qm", "initial");
  const workspace = await core.registerWorkspace(project.id, other);
  expect(await core.gitRepository(workspace.id)).toMatchObject({
    status: "unavailable",
    message: expect.stringContaining("不属于"),
  });
  await expect(
    core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: workspace.id,
      branch: { kind: "new", name: "eta/wrong" },
      requestId: "wrong-repository",
    }),
  ).rejects.toMatchObject({ code: "InvalidInput", message: expect.stringContaining("不属于") });
});

test("a Core-created worktree supports editing and committing in the native workspace sandbox", async () => {
  const { core, directory, root, project, base, agent } = await fixture({ defaultRoot: true });
  const created = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "new", name: "eta/native" },
    requestId: "native",
  });
  const thread = await core.createThread(created.workspaceId!);
  expect(created.path.startsWith(join(directory, "data-worktrees"))).toBe(true);
  agent.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command:
          "echo proof > proof.txt && git add proof.txt && git -c user.name=Eta -c user.email=eta@example.com commit -qm native-proof",
        sandbox: { gitMetadata: true, reason: "Commit this task" },
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  const operation = await core.submit(thread.id, "Create and commit proof.txt");
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.length, {
      timeout: 15000,
    })
    .toBe(1);
  const approval = (await core.openThread(thread.id)).snapshot.approvals![0]!;
  await expect(
    core.removeWorktree(created.workspaceId!, "busy-native-remove"),
  ).rejects.toMatchObject({ code: "Busy" });
  await core.decideApproval(thread.id, approval.id, true);
  await expect
    .poll(async () => (await core.operation(thread.id, operation.operationId)).status, {
      timeout: 15000,
    })
    .toBe("completed");
  expect(await readFile(join(created.cwd, "proof.txt"), "utf8")).toBe("proof\n");
  expect((await git(created.cwd, "log", "-1", "--format=%s")).trim()).toBe("native-proof");
  await expect(access(join(root, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30000);

test("removal retains the live branch after external checkout and refuses detached commits", async () => {
  const { core, project, base } = await fixture();
  const created = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "new", name: "eta/original" },
    requestId: "live-branch",
  });
  await git(created.cwd, "switch", "-c", "eta/current");
  expect(await core.listWorktrees(project.id)).toMatchObject([{ branch: "eta/current" }]);
  await git(created.cwd, "switch", "--detach");
  await expect(core.removeWorktree(created.workspaceId!, "detached-remove")).rejects.toMatchObject({
    message: expect.stringContaining("创建分支保留"),
  });
  await git(created.cwd, "switch", "eta/current");
  expect(await core.removeWorktree(created.workspaceId!, "live-remove")).toMatchObject({
    status: "removed",
    branch: "eta/current",
  });
  expect(
    await core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "existing", name: "eta/current" },
      continuesWorkspaceId: created.workspaceId,
      requestId: "live-resume",
    }),
  ).toMatchObject({ branch: "eta/current", status: "ready", continues: created.workspaceId });
});
