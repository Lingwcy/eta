import { createRegistry, Harness, MemoryStorage } from "@eta/agent";
import { NodeExecutionEnv } from "@eta/agent/env/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vite-plus/test";
import { createReviewTask } from "../../../src/service/runtime/review.ts";
import type { ReviewOptions } from "../../../src/service/runtime/review.ts";
import { createSandboxApprovals } from "../../../src/service/runtime/approvals.ts";
import { ApprovalsDoc } from "../../../src/service/runtime/approval-doc.ts";

async function fixture(options: Partial<ReviewOptions> = {}, startedAt?: number) {
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const task = createReviewTask({
    reviewer: async () => ({ mode: "auto" }),
    available: async () => true,
    record: async () => {},
    timeoutMs: 100,
    ...options,
  });
  const registry = createRegistry();
  registry.install({ name: "review-test", tasks: [task] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const start = () =>
    root.commit(async (tx) => {
      const taskId = await tx.createTask(
        task,
        { requestId: "request" },
        { ownership: { kind: "conversation" } },
      );
      (await tx.doc(ApprovalsDoc)).requests.push({
        id: "request",
        taskId,
        toolTaskId: "tool",
        conversationId: String(root.id),
        tool: "bash",
        args: { command: "true" },
        reason: "Task",
        mode: "read-only",
        revision: 0,
        status: "pending",
        readableRoots: [],
        writableRoots: [],
        networkAccess: false,
        ...(startedAt === undefined ? {} : { review: { status: "reviewing", startedAt } }),
      });
      return taskId;
    }, context);
  const approval = async () => (await harness.snapshot(ApprovalsDoc, context))!.requests[0]!;
  return { harness, root, faux, start, approval };
}

test("the total review deadline cancels a tool and leaves the request for the user", async () => {
  const env = new NodeExecutionEnv({ cwd: process.cwd() });
  let toolSignal: AbortSignal | undefined;
  const execute = vi
    .spyOn(env, "exec")
    .mockImplementation(async (_command, _options, invocation) => {
      toolSignal = invocation.abortSignal;
      return new Promise((_, reject) =>
        invocation.abortSignal!.addEventListener(
          "abort",
          () => reject(invocation.abortSignal!.reason),
          { once: true },
        ),
      );
    });
  const cleanup = vi.spyOn(env, "cleanup");
  const f = await fixture({ tools: { root: process.cwd(), open: async () => env } });
  try {
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("git", { args: ["status"] }), { stopReason: "toolUse" }),
    ]);
    const id = await f.start();
    await f.harness.waitForTask(id, context);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolSignal?.aborted).toBe(true);
    await expect.poll(() => cleanup.mock.calls.length).toBe(1);
    expect(await f.approval()).toMatchObject({
      status: "pending",
      review: { status: "skipped", skippedReason: "timeout", toolCalls: [{ tool: "git" }] },
    });
  } finally {
    await f.harness.close(context);
    vi.restoreAllMocks();
  }
});

test("a hung reviewer availability check falls back within the same deadline", async () => {
  const f = await fixture({
    reviewer: async () => ({ mode: "auto", model: { provider: "faux", modelId: "faux-1" } }),
    available: () => new Promise(() => {}),
  });
  try {
    const id = await f.start();
    await f.harness.waitForTask(id, context);
    expect(await f.approval()).toMatchObject({
      status: "pending",
      review: { skippedReason: "timeout" },
    });
  } finally {
    await f.harness.close(context);
  }
});

test("a resumed review with a persisted start marker does not call the model again", async () => {
  const available = vi.fn(async () => true);
  const f = await fixture({ available }, 1);
  try {
    const id = await f.start();
    await f.harness.waitForTask(id, context);
    expect(await f.approval()).toMatchObject({
      status: "pending",
      review: { skippedReason: "interrupted" },
    });
    expect(available).not.toHaveBeenCalled();
  } finally {
    await f.harness.close(context);
  }
});

test("switching to manual approval while a review runs discards an automatic verdict", async () => {
  let automatic = true;
  const f = await fixture({
    timeoutMs: 5000,
    reviewer: async () => ({ mode: automatic ? "auto" : "user" }),
  });
  try {
    f.faux.setResponses([
      () => {
        automatic = false;
        return fauxAssistantMessage(
          JSON.stringify({ decision: "approve", risk: "low", rationale: "Routine" }),
        );
      },
    ]);
    const id = await f.start();
    await f.harness.waitForTask(id, context);
    expect(await f.approval()).toMatchObject({
      status: "pending",
      review: { skippedReason: "interrupted" },
    });
    expect((await f.approval()).decidedBy).toBeUndefined();
  } finally {
    await f.harness.close(context);
  }
});

test("switching to manual review removes automatic run grants permanently and keeps user grants", async () => {
  const f = await fixture();
  let automatic = false;
  const approvals = createSandboxApprovals(
    () => f.harness,
    process.cwd(),
    async () => {},
    [],
    {
      reviewer: async () => ({ mode: automatic ? "auto" : "user" }),
      available: async () => true,
      record: async () => {},
    },
  );
  try {
    const taskId = await f.start();
    await f.harness.waitForTask(taskId, context);
    await f.root.commit(async (tx) => {
      const doc = await tx.doc(ApprovalsDoc);
      const grant = {
        id: "original",
        taskId,
        conversationId: String(f.root.id),
        revision: 0,
        readableRoots: [],
        writableRoots: [],
      };
      doc.runGrants = [
        { ...grant, by: "auto" },
        { ...grant, id: "user", by: "user" },
      ];
    }, context);
    await approvals.withdrawAutoRunGrants(f.root.id);
    automatic = true;
    await approvals.withdrawAutoRunGrants(f.root.id);
    expect((await f.harness.snapshot(ApprovalsDoc, context))!.runGrants).toMatchObject([
      { id: "user", by: "user" },
    ]);
  } finally {
    await f.harness.close(context);
  }
});

test("a stalled final settings check cannot approve after the review deadline", async () => {
  let reads = 0;
  const f = await fixture({
    reviewer: async () => (++reads === 1 ? { mode: "auto" } : new Promise(() => {})),
  });
  try {
    f.faux.setResponses([
      fauxAssistantMessage(
        JSON.stringify({ decision: "approve", risk: "low", rationale: "Routine" }),
      ),
    ]);
    const id = await f.start();
    await f.harness.waitForTask(id, context);
    expect(await f.approval()).toMatchObject({
      status: "pending",
      review: { skippedReason: "timeout" },
    });
  } finally {
    await f.harness.close(context);
  }
});
