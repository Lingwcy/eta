import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Effect } from "effect";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore } from "../src/client.ts";
import type { CoreClient } from "../src/client.ts";
import type { ApprovalReviewer } from "../src/shared/runtime-settings.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args], { cwd });

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** A repository with a linked worktree on `eta/feature`, opened as its own project. */
async function fixture(approvalReviewer: ApprovalReviewer | null = null, subdirectory = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "eta-gitmeta-")));
  directories.push(directory);
  const main = join(directory, "main");
  await mkdir(join(main, "pkg"), { recursive: true });
  await git(main, "init", "-q", "-b", "main");
  await writeFile(join(main, "pkg", "README.md"), "hello\n");
  await git(main, "add", ".");
  await git(main, "commit", "-q", "-m", "init");
  const worktree = join(directory, "worktree");
  const other = join(directory, "other");
  await git(main, "worktree", "add", "-q", "-b", "eta/feature", worktree);
  await git(main, "worktree", "add", "-q", "-b", "eta/other", other);
  const agent = fauxProvider({
    provider: "core-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const side = fauxProvider({
    provider: "core-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const models = createModels();
  models.setProvider({
    ...agent.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title") || options?.sessionId?.endsWith(":review")
        ? side.provider.streamSimple(model, context, options)
        : agent.provider.streamSimple(model, context, options),
  });
  const core = await createCore({
    dataRoot: join(directory, "data"),
    home: directory,
    models,
    settings: {
      read: Effect.succeed({
        defaultThinkingLevel: "off",
        ...(approvalReviewer ? { approvalReviewer } : {}),
      }),
      subscribe: () => () => {},
    },
    environment: { userAgent: "eta-core-test", shutdown: "preserve" },
  });
  clients.push(core);
  const cwd = subdirectory ? join(main, "pkg") : worktree;
  const project = await core.registerProject(cwd);
  const workspace = (await core.workspaces(project.id))[0]!;
  const thread = await core.createThread(workspace.id);
  return { core, agent, side, main, worktree, other, cwd, thread };
}

const bash = (command: string, sandbox?: { gitMetadata: boolean; reason: string }) =>
  fauxAssistantMessage(fauxToolCall("bash", { command, ...(sandbox ? { sandbox } : {}) }), {
    stopReason: "toolUse",
  });
const commit =
  "git add new.txt && git -c user.name=Eta -c user.email=eta@example.com commit -qm from-agent";

async function settle(core: CoreClient, threadId: string, operationId: string) {
  await expect
    .poll(async () => (await core.operation(threadId, operationId)).status, { timeout: 15000 })
    .toBe("completed");
}

async function pending(core: CoreClient, threadId: string) {
  await expect
    .poll(async () => (await core.openThread(threadId)).snapshot.approvals?.length, {
      timeout: 15000,
    })
    .toBe(1);
  return (await core.openThread(threadId)).snapshot.approvals![0]!;
}

const subject = async (cwd: string) => (await git(cwd, "log", "-1", "--format=%s")).stdout.trim();

test("a worktree reads its Git state freely but cannot commit without a grant", async () => {
  const { core, agent, worktree, thread } = await fixture();
  await writeFile(join(worktree, "new.txt"), "agent change\n");
  agent.setResponses([
    bash(`git status --short > status.txt; (${commit}) 2> commit.txt; true`),
    fauxAssistantMessage("Done"),
  ]);
  const operation = await core.submit(thread.id, "Commit");
  await settle(core, thread.id, operation.operationId);
  expect(await readFile(join(worktree, "status.txt"), "utf8")).toContain("?? new.txt");
  expect(await subject(worktree)).toBe("init");
});

test("an approved gitMetadata request commits without exposing config, hooks or other worktrees", async () => {
  const { core, agent, main, worktree, other, thread } = await fixture();
  await writeFile(join(worktree, "new.txt"), "agent change\n");
  const common = join(main, ".git");
  agent.setResponses([
    bash(
      `${commit}; echo bad >> '${common}/config'; echo bad > '${common}/hooks/pre-commit'; echo bad > '${common}/worktrees/other/HEAD'; true`,
      { gitMetadata: true, reason: "Commit the change" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  const operation = await core.submit(thread.id, "Commit");
  const approval = await pending(core, thread.id);
  expect(approval.gitMetadata).toEqual({
    commonDir: common,
    worktreeDir: join(common, "worktrees", "worktree"),
    branch: "eta/feature",
  });
  expect(approval.writableRoots).toEqual([
    join(common, "worktrees", "worktree"),
    join(common, "objects"),
    join(common, "refs", "heads", "eta"),
    join(common, "logs", "refs", "heads", "eta"),
  ]);
  await core.decideApproval(thread.id, approval.id, true);
  await settle(core, thread.id, operation.operationId);
  expect(await subject(worktree)).toBe("from-agent");
  expect(await readFile(join(common, "config"), "utf8")).not.toContain("bad");
  await expect(readFile(join(common, "hooks", "pre-commit"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(common, "worktrees", "other", "HEAD"), "utf8")).toContain("eta/other");
  expect(await subject(other)).toBe("init");
});

test("automatic review approves routine worktree commits", async () => {
  const { core, agent, side, worktree, thread } = await fixture({ mode: "auto" });
  await writeFile(join(worktree, "new.txt"), "agent change\n");
  agent.setResponses([
    bash(commit, { gitMetadata: true, reason: "Commit the change" }),
    fauxAssistantMessage("Done"),
  ]);
  side.setResponses([
    fauxAssistantMessage("Title"),
    fauxAssistantMessage(
      JSON.stringify({ decision: "approve", risk: "low", rationale: "Routine commit" }),
    ),
  ]);
  const operation = await core.submit(thread.id, "Commit");
  await settle(core, thread.id, operation.operationId);
  expect(await subject(worktree)).toBe("from-agent");
});

test("a project inside a main checkout hands its gitMetadata request to the user", async () => {
  const { core, agent, thread } = await fixture({ mode: "auto" }, true);
  agent.setResponses([
    bash("git add -A", { gitMetadata: true, reason: "Stage files" }),
    fauxAssistantMessage("Done"),
  ]);
  await core.submit(thread.id, "Stage");
  const approval = await pending(core, thread.id);
  expect(approval.review).toEqual({ status: "skipped", skippedReason: "requires-user" });
});
