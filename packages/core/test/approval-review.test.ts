import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import { gitCommand } from "../src/service/runtime/review-tools.ts";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(
  approvalReviewer: ApprovalReviewer | null = { mode: "auto" },
  reviewerSpeed = 10000,
) {
  const directory = await mkdtemp(join(tmpdir(), "eta-review-"));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const agent = fauxProvider({
    provider: "core-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const reviewer = fauxProvider({
    provider: "core-test",
    models: [{ id: "one" }],
    tokensPerSecond: reviewerSpeed,
  });
  const titles = fauxProvider({
    provider: "core-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  let reviews = 0;
  const requests: string[] = [];
  const reviewRequests: string[] = [];
  const models = createModels();
  models.setProvider({
    ...agent.provider,
    streamSimple: (model, context, options) => {
      if (options?.sessionId?.endsWith(":review")) {
        reviews++;
        reviewRequests.push(JSON.stringify(context.messages));
        return reviewer.provider.streamSimple(model, context, options);
      }
      if (options?.sessionId?.endsWith(":title"))
        return titles.provider.streamSimple(model, context, options);
      requests.push(JSON.stringify(context.messages));
      return agent.provider.streamSimple(model, context, options);
    },
  });
  const dataRoot = join(directory, "data");
  const core = await createCore({
    dataRoot,
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
  const project = await core.registerProject(cwd);
  const workspace = (await core.workspaces(project.id))[0]!;
  const thread = await core.createThread(workspace.id);
  await core.configureSandbox(thread.id, "read-only");
  const log = async () =>
    (await readFile(join(dataRoot, "approval-reviews.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    core,
    agent,
    reviewer,
    cwd,
    directory,
    thread,
    log,
    reviews: () => reviews,
    agentRequests: () => requests,
    reviewRequests: () => reviewRequests,
  };
}

const verdict = (decision: string, risk = "low", rationale = "Needed for the task") =>
  fauxAssistantMessage(JSON.stringify({ decision, risk, rationale }));
const write = (path: string) =>
  fauxAssistantMessage(fauxToolCall("write", { path, content: "written" }), {
    stopReason: "toolUse",
  });

async function settle(core: CoreClient, threadId: string, operationId: string) {
  await expect
    .poll(async () => (await core.operation(threadId, operationId)).status, { timeout: 10000 })
    .toBe("completed");
  return core.operation(threadId, operationId);
}

async function pending(core: CoreClient, threadId: string) {
  await expect
    .poll(async () => (await core.openThread(threadId)).snapshot.approvals?.length, {
      timeout: 10000,
    })
    .toBe(1);
  return (await core.openThread(threadId)).snapshot.approvals![0]!;
}

test("an automatic approval runs the call once and is recorded without file contents", async () => {
  const { core, agent, reviewer, cwd, thread, log } = await fixture();
  agent.setResponses([write("approved.txt"), fauxAssistantMessage("Done")]);
  reviewer.setResponses([verdict("approve")]);
  const operation = await core.submit(thread.id, "Write approved.txt");
  await settle(core, thread.id, operation.operationId);
  expect(await readFile(join(cwd, "approved.txt"), "utf8")).toBe("written");
  await expect.poll(log).toMatchObject([
    {
      kind: "review",
      outcome: "approved",
      risk: "low",
      tool: "write",
      reviewer: { provider: "core-test", modelId: "one" },
    },
  ]);
  expect(JSON.stringify(await log())).not.toContain("written");
});

test("an automatic denial blocks the call and tells the agent why", async () => {
  const { core, agent, reviewer, cwd, thread, agentRequests } = await fixture();
  agent.setResponses([write("denied.txt"), fauxAssistantMessage("Understood")]);
  reviewer.setResponses([verdict("deny", "medium", "Writing denied.txt is not part of the task")]);
  const operation = await core.submit(thread.id, "Summarize the repo");
  await settle(core, thread.id, operation.operationId);
  await expect(readFile(join(cwd, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(agentRequests().at(-1)).toContain("Writing denied.txt is not part of the task");
});

test.each([
  ["ask_user", "low"],
  ["approve", "high"],
])(
  "a %s verdict at %s risk stays pending for the user and records the final decision",
  async (decision, risk) => {
    const { core, agent, reviewer, cwd, thread, log } = await fixture();
    agent.setResponses([write("escalated.txt"), fauxAssistantMessage("Done")]);
    reviewer.setResponses([verdict(decision, risk, "The user should confirm this write")]);
    const operation = await core.submit(thread.id, "Write");
    await expect
      .poll(
        async () => (await core.openThread(thread.id)).snapshot.approvals?.[0]?.review?.status,
        {
          timeout: 10000,
        },
      )
      .toBe("escalated");
    const approval = await pending(core, thread.id);
    expect(approval.review).toMatchObject({ rationale: "The user should confirm this write" });
    await core.decideApproval(thread.id, approval.id, true);
    await settle(core, thread.id, operation.operationId);
    expect(await readFile(join(cwd, "escalated.txt"), "utf8")).toBe("written");
    await expect.poll(log).toMatchObject([
      { kind: "review", outcome: "escalated" },
      { kind: "user-decision", approved: true, review: "escalated" },
    ]);
  },
);

test("unparseable reviewer output falls back to the user instead of approving", async () => {
  const { core, agent, reviewer, cwd, thread } = await fixture();
  agent.setResponses([write("unclear.txt"), fauxAssistantMessage("Done")]);
  reviewer.setResponses([fauxAssistantMessage("Looks fine to me")]);
  await core.submit(thread.id, "Write");
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.[0]?.review, {
      timeout: 10000,
    })
    .toMatchObject({ status: "skipped", skippedReason: "invalid-output" });
  await expect(readFile(join(cwd, "unclear.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("an unavailable configured reviewer is not replaced by another model", async () => {
  const { core, agent, thread, reviews } = await fixture({
    mode: "auto",
    model: { provider: "core-test", modelId: "missing" },
  });
  agent.setResponses([write("missing.txt"), fauxAssistantMessage("Done")]);
  await core.submit(thread.id, "Write");
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.[0]?.review, {
      timeout: 10000,
    })
    .toMatchObject({
      status: "skipped",
      skippedReason: "reviewer-unavailable",
      reviewer: { modelId: "missing" },
    });
  expect(reviews()).toBe(0);
});

test("another repository's Git metadata is never offered to the reviewer", async () => {
  const { core, agent, directory, thread, reviews } = await fixture();
  const other = join(directory, "other");
  await mkdir(join(other, ".git"), { recursive: true });
  agent.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command: "true",
        sandbox: { writableRoots: [other], reason: "Edit the other checkout" },
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  await core.configureSandbox(thread.id, "workspace-write");
  await core.submit(thread.id, "Edit");
  const approval = await pending(core, thread.id);
  expect(approval.review).toEqual({ status: "skipped", skippedReason: "requires-user" });
  expect(reviews()).toBe(0);
});

test("consecutive automatic denials hand the next request to the user", async () => {
  const { core, agent, reviewer, thread, reviews } = await fixture();
  agent.setResponses([
    write("a.txt"),
    write("b.txt"),
    write("c.txt"),
    write("d.txt"),
    fauxAssistantMessage("Done"),
  ]);
  reviewer.setResponses([verdict("deny"), verdict("deny"), verdict("deny")]);
  await core.submit(thread.id, "Write files");
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.[0]?.args, {
      timeout: 10000,
    })
    .toMatchObject({ path: "d.txt" });
  const approval = await pending(core, thread.id);
  expect(approval.review).toEqual({ status: "skipped", skippedReason: "circuit-breaker" });
  expect(reviews()).toBe(3);
});

test("a user decision made during review wins and the late verdict is discarded", async () => {
  const { core, agent, reviewer, cwd, thread, log } = await fixture({ mode: "auto" }, 40);
  agent.setResponses([write("user.txt"), fauxAssistantMessage("Done")]);
  reviewer.setResponses([verdict("deny", "low", "A deliberately slow denial verdict")]);
  const operation = await core.submit(thread.id, "Write");
  const approval = await pending(core, thread.id);
  expect(approval.review?.status).toBe("reviewing");
  await core.decideApproval(thread.id, approval.id, true);
  await settle(core, thread.id, operation.operationId);
  expect(await readFile(join(cwd, "user.txt"), "utf8")).toBe("written");
  await expect
    .poll(async () => (await log()).find((entry) => entry.kind === "review"), { timeout: 15000 })
    .toMatchObject({ outcome: "preempted" });
});

test("the user reviewer keeps today's approval flow", async () => {
  const { core, agent, thread, reviews } = await fixture(null);
  agent.setResponses([write("manual.txt"), fauxAssistantMessage("Done")]);
  await core.submit(thread.id, "Write");
  const approval = await pending(core, thread.id);
  expect(approval.review).toBeUndefined();
  expect(reviews()).toBe(0);
});

const reviewerCalls = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

test("the reviewer can read the workspace but nothing outside it", async () => {
  const { core, agent, reviewer, cwd, directory, thread, reviewRequests } = await fixture();
  await writeFile(join(cwd, "notes.txt"), "workspace notes for the reviewer");
  await writeFile(join(directory, "outside.txt"), "secret outside the workspace");
  agent.setResponses([write("reviewed.txt"), fauxAssistantMessage("Done")]);
  reviewer.setResponses([
    reviewerCalls(
      fauxToolCall("read", { path: "notes.txt" }),
      fauxToolCall("read", { path: "../outside.txt" }),
      fauxToolCall("list", { path: "." }),
    ),
    verdict("approve"),
  ]);
  const operation = await core.submit(thread.id, "Write");
  await settle(core, thread.id, operation.operationId);
  const followUp = reviewRequests().at(-1)!;
  expect(followUp).toContain("workspace notes for the reviewer");
  expect(followUp).toContain("审查器无权访问此路径");
  expect(followUp).not.toContain("secret outside the workspace");
  expect(await readFile(join(cwd, "reviewed.txt"), "utf8")).toBe("written");
});

test("the reviewer's git runs read-only subcommands and rejects the rest", async () => {
  const { core, agent, reviewer, cwd, thread, reviewRequests } = await fixture();
  await promisify(execFile)("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, "untracked.txt"), "new");
  agent.setResponses([write("git.txt"), fauxAssistantMessage("Done")]);
  reviewer.setResponses([
    reviewerCalls(
      fauxToolCall("git", { args: ["status", "--short"] }),
      fauxToolCall("git", { args: ["diff", "--no-index", "/etc/hosts", "untracked.txt"] }),
      fauxToolCall("git", { args: ["branch", "created-by-reviewer"] }),
      fauxToolCall("git", { args: ["commit", "-m", "x"] }),
    ),
    verdict("approve"),
  ]);
  const operation = await core.submit(thread.id, "Write");
  await settle(core, thread.id, operation.operationId);
  const followUp = reviewRequests().at(-1)!;
  expect(followUp).toContain("?? untracked.txt");
  expect(followUp).toContain("不允许的 git 参数：--no-index");
  expect(followUp).toContain("git branch 只能列出分支");
  expect(followUp).toContain("不允许的 git 子命令：commit");
});

test("a reviewer exceeding its tool budget hands the request to the user", async () => {
  const { core, agent, reviewer, thread } = await fixture();
  agent.setResponses([write("budget.txt"), fauxAssistantMessage("Done")]);
  reviewer.setResponses([
    reviewerCalls(...Array.from({ length: 9 }, () => fauxToolCall("list", { path: "." }))),
  ]);
  await core.submit(thread.id, "Write");
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.[0]?.review, {
      timeout: 10000,
    })
    .toMatchObject({ status: "skipped", skippedReason: "tool-budget" });
});

test("reviewer git commands neutralise repository configuration that executes code", () => {
  const command = gitCommand(["diff", "HEAD"]);
  for (const flag of [
    "core.fsmonitor=false",
    "core.hooksPath=/dev/null",
    "--no-ext-diff",
    "--no-textconv",
  ])
    expect(command).toContain(flag);
  for (const args of [
    ["log", "-c", "x"],
    ["show", "--output=/tmp/x"],
    ["diff", "-O/etc/hosts"],
    ["status", "--git-dir=/elsewhere"],
    ["rev-parse", "-C", "/"],
  ])
    expect(() => gitCommand(args)).toThrow("不允许的 git 参数");
  expect(gitCommand(["log", "--oneline", "-n", "5", "it's"])).toContain(`'it'\\''s'`);
});
