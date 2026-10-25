import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ManagedRuntime } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, ROOT_CONVERSATION_ID } from "@eta/agent";
import { ApprovalsDoc } from "../src/service/runtime/approval-doc.ts";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { testServices, TestSettings } from "./support/runtime.ts";
import { ProjectService } from "../src/service/projects/index.ts";
import { WorkspaceService } from "../src/service/workspaces/index.ts";
import { ThreadService } from "../src/service/threads/index.ts";
import { RuntimeRegistryService } from "../src/service/runtime/index.ts";

const runtimes: { dispose(): Promise<void> }[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args], { cwd });
const tool = (name: string) =>
  fauxAssistantMessage(
    fauxToolCall("bash", {
      command:
        "echo " +
        name +
        " > " +
        name +
        ".txt && git add " +
        name +
        ".txt && git -c user.name=Eta -c user.email=eta@example.com commit -qm " +
        name,
      sandbox: { gitMetadata: true, reason: "Commit test change" },
    }),
    { stopReason: "toolUse" },
  );
const verdict = (decision: "approve" | "ask_user") =>
  fauxAssistantMessage(
    JSON.stringify({ decision, risk: "low", rationale: "Controlled review", reuse: "run" }),
  );

async function fixture(auto: boolean) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "eta-run-grants-")));
  directories.push(directory);
  const main = join(directory, "main");
  const cwd = join(directory, "worktree");
  await mkdir(main);
  await git(main, "init", "-q", "-b", "main");
  await writeFile(join(main, "initial.txt"), "Initial");
  await git(main, "add", ".");
  await git(main, "commit", "-q", "-m", "initial");
  await git(main, "worktree", "add", "-q", "-b", "eta/feature", cwd);
  const agent = fauxProvider({
    provider: "grant-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "grant-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const reviewer = fauxProvider({
    provider: "grant-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  let reviews = 0;
  const models = createModels();
  models.setProvider({
    ...agent.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? titles.provider.streamSimple(model, context, options)
        : options?.sessionId?.endsWith(":review")
          ? (reviews++, reviewer.provider.streamSimple(model, context, options))
          : agent.provider.streamSimple(model, context, options),
  });
  const runtime = ManagedRuntime.make(
    testServices(join(directory, "data"), models, undefined, directory),
  );
  runtimes.push(runtime);
  if (auto)
    await runtime.runPromise(
      (await runtime.runPromise(TestSettings)).update({ approvalReviewer: { mode: "auto" } }),
    );
  const projects = await runtime.runPromise(ProjectService);
  const project = await runtime.runPromise(projects.register({ rootPath: cwd }));
  const workspace = (
    await runtime.runPromise((await runtime.runPromise(WorkspaceService)).list(project.id))
  )[0]!;
  const threads = await runtime.runPromise(ThreadService);
  const thread = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(
    (await runtime.runPromise(RuntimeRegistryService)).acquire(thread.thread.sessionRef),
  );
  expect((await record.sandbox()).available).toBe(true);
  const release = Promise.withResolvers<void>();
  let held = false;
  let cleared = false;
  const expire = record.approvals.expireRunGrants.bind(record.approvals);
  vi.spyOn(record.approvals, "expireRunGrants").mockImplementation(async (id) => {
    if (!held) {
      held = true;
      await release.promise;
      try {
        await expire(id);
      } finally {
        cleared = true;
      }
    } else await expire(id);
  });
  const open = () => runtime.runPromise(threads.open(thread.id));
  const pending = async () => {
    await expect
      .poll(async () => (await open()).snapshot.approvals?.length, { timeout: 15_000 })
      .toBe(1);
    const request = (await open()).snapshot.approvals![0]!;
    expect(request).not.toHaveProperty("rootRunId");
    return request;
  };
  const submit = (prompt: string) => runtime.runPromise(threads.submit(thread.id, prompt));
  const settle = async (id: string) => {
    await expect
      .poll(async () => (await runtime.runPromise(threads.operation(thread.id, id))).status, {
        timeout: 15_000,
      })
      .toBe("completed");
  };
  const boundary = async (id: string) => {
    if ((await open()).snapshot.approvals?.length) return "pending";
    return (await runtime.runPromise(threads.operation(thread.id, id))).status;
  };
  const subject = async () => (await git(cwd, "log", "-1", "--format=%s")).stdout.trim();
  return {
    runtime,
    directory,
    models,
    threads,
    thread,
    record,
    agent,
    reviewer,
    pending,
    submit,
    settle,
    boundary,
    subject,
    reviews: () => reviews,
    held: () => held,
    cleared: () => cleared,
    release: () => release.resolve(),
  };
}

test.each([false, true])(
  "a later run cannot reuse a grant while old expiry waits (auto=%s)",
  async (auto) => {
    const f = await fixture(auto);
    try {
      f.agent.setResponses([
        tool("first"),
        fauxAssistantMessage("Done"),
        tool("second"),
        fauxAssistantMessage("Done"),
      ]);
      f.reviewer.setResponses([verdict("approve"), verdict("ask_user")]);
      const first = await f.submit("First run");
      if (!auto) {
        const request = await f.pending();
        await f.runtime.runPromise(f.threads.decideApproval(f.thread.id, request.id, true, "run"));
      }
      await f.settle(first.operationId);
      await expect.poll(f.held, { timeout: 10_000 }).toBe(true);
      expect(await f.subject()).toBe("first");
      const second = await f.submit("A new run needs new authorization");
      // submit() initially returns a pending operation before it reaches authorization;
      // wait for the second request itself, not merely for a non-running operation state.
      await f.pending();
      expect({
        state: await f.boundary(second.operationId),
        subject: await f.subject(),
        reviews: auto ? f.reviews() : undefined,
      }).toEqual({ state: "pending", subject: "first", reviews: auto ? 2 : undefined });
    } finally {
      f.release();
      await f.runtime.runPromise(f.threads.stop(f.thread.id)).catch(() => {});
    }
  },
  45_000,
);

test("late expiry does not revoke a new run's approved scope", async () => {
  const f = await fixture(false);
  const next = Promise.withResolvers<void>();
  let between = false;
  try {
    f.agent.setResponses([tool("first"), fauxAssistantMessage("Done")]);
    const first = await f.submit("First run");
    const request = await f.pending();
    await f.runtime.runPromise(f.threads.decideApproval(f.thread.id, request.id, true, "run"));
    await f.settle(first.operationId);
    await expect.poll(f.held, { timeout: 10_000 }).toBe(true);
    await f.runtime.runPromise(f.threads.configureSandbox(f.thread.id, "read-only"));
    await f.runtime.runPromise(f.threads.configureSandbox(f.thread.id, "workspace-write"));
    f.agent.setResponses([
      tool("second"),
      async () => {
        between = true;
        await next.promise;
        return tool("third");
      },
      fauxAssistantMessage("Done"),
    ]);
    const second = await f.submit("A separately approved new run");
    const approval = await f.pending();
    await f.runtime.runPromise(f.threads.decideApproval(f.thread.id, approval.id, true, "run"));
    await expect.poll(() => between, { timeout: 15_000 }).toBe(true);
    expect(await f.subject()).toBe("second");
    f.release();
    await expect.poll(f.cleared, { timeout: 10_000 }).toBe(true);
    next.resolve();
    await expect
      .poll(() => f.boundary(second.operationId), { timeout: 15_000 })
      .not.toBe("running");
    expect({ state: await f.boundary(second.operationId), subject: await f.subject() }).toEqual({
      state: "completed",
      subject: "third",
    });
  } finally {
    next.resolve();
    f.release();
    await f.runtime.runPromise(f.threads.stop(f.thread.id)).catch(() => {});
  }
}, 45_000);

test("legacy grants without a root owner cannot authorize another call", async () => {
  const f = await fixture(false);
  const next = Promise.withResolvers<void>();
  let between = false;
  try {
    f.agent.setResponses([
      tool("first"),
      async () => {
        between = true;
        await next.promise;
        return tool("second");
      },
      fauxAssistantMessage("Done"),
    ]);
    const operation = await f.submit("Check persisted legacy grant shape");
    const request = await f.pending();
    await f.runtime.runPromise(f.threads.decideApproval(f.thread.id, request.id, true, "run"));
    await expect.poll(() => between, { timeout: 15_000 }).toBe(true);
    await f.record.conversation.commit(async (tx) => {
      const doc = await tx.doc(ApprovalsDoc);
      expect(doc.runGrants).toHaveLength(1);
      for (const grant of doc.runGrants!) delete grant.rootRunId;
    }, BACKGROUND_CONTEXT);
    next.resolve();
    await expect
      .poll(() => f.boundary(operation.operationId), { timeout: 15_000 })
      .not.toBe("running");
    expect({ state: await f.boundary(operation.operationId), subject: await f.subject() }).toEqual({
      state: "pending",
      subject: "first",
    });
  } finally {
    next.resolve();
    f.release();
    await f.runtime.runPromise(f.threads.stop(f.thread.id)).catch(() => {});
  }
}, 45_000);

test("a child called while root is idle only receives call-scoped approval", async () => {
  const f = await fixture(false);
  try {
    f.agent.setResponses([tool("first"), tool("second"), fauxAssistantMessage("Done")]);
    await f.runtime.runPromise(
      f.threads.subagent(
        f.thread.id,
        { action: "spawn", name: "worker", message: "Commit independently" },
        "idle-root-child",
      ),
    );
    const request = await f.pending();
    expect(
      (await f.record.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.run,
    ).toBeUndefined();
    await f.runtime.runPromise(f.threads.decideApproval(f.thread.id, request.id, true, "run"));
    const boundary = async () =>
      (await f.record.approvals.list()).length
        ? "pending"
        : (await f.record.subagents.list())[0]?.status;
    await expect.poll(boundary, { timeout: 15_000 }).not.toBe("running");
    expect({
      reusable: request.reusable === true,
      state: await boundary(),
      subject: await f.subject(),
    }).toEqual({ reusable: false, state: "pending", subject: "first" });
  } finally {
    f.release();
    await f.runtime.runPromise(f.threads.stop(f.thread.id)).catch(() => {});
  }
}, 45_000);

test("a child's Git scope can still be reused within an active root run", async () => {
  const f = await fixture(false);
  const root = Promise.withResolvers<void>();
  let waiting = false;
  try {
    f.agent.setResponses([
      async () => {
        waiting = true;
        await root.promise;
        return fauxAssistantMessage("Root done");
      },
      tool("first"),
      tool("second"),
      fauxAssistantMessage("Child done"),
      fauxAssistantMessage("Child completion acknowledged"),
    ]);
    const operation = await f.submit("Keep this root run active");
    await expect.poll(() => waiting, { timeout: 10_000 }).toBe(true);
    await f.runtime.runPromise(
      f.threads.subagent(
        f.thread.id,
        { action: "spawn", name: "worker", message: "Commit within the current root run" },
        "active-root-child",
      ),
    );
    const request = await f.pending();
    expect(request.reusable).toBe(true);
    await f.runtime.runPromise(f.threads.decideApproval(f.thread.id, request.id, true, "run"));
    await expect
      .poll(async () => (await f.record.subagents.list())[0]?.status, { timeout: 15_000 })
      .toBe("completed");
    expect(await f.subject()).toBe("second");
    expect(await f.record.approvals.list()).toHaveLength(0);
    for (const entry of await f.record.approvals.history())
      expect(entry).not.toHaveProperty("rootRunId");
    root.resolve();
    await expect
      .poll(() => f.boundary(operation.operationId), { timeout: 15_000 })
      .not.toBe("running");
    expect(
      await f.runtime.runPromise(f.threads.operation(f.thread.id, operation.operationId)),
    ).toMatchObject({ status: "completed" });
  } finally {
    root.resolve();
    f.release();
    await f.runtime.runPromise(f.threads.stop(f.thread.id)).catch(() => {});
  }
}, 45_000);

test("reopening Core withdraws persisted grants before another run can execute", async () => {
  const f = await fixture(false);
  try {
    f.agent.setResponses([tool("first"), fauxAssistantMessage("Done")]);
    const first = await f.submit("First run");
    const approval = await f.pending();
    await f.runtime.runPromise(f.threads.decideApproval(f.thread.id, approval.id, true, "run"));
    await f.settle(first.operationId);
    await expect.poll(f.held, { timeout: 10_000 }).toBe(true);
    expect(
      (await f.record.harness.snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))?.runGrants,
    ).toHaveLength(1);
    await f.runtime.dispose();
    f.release();
    await expect.poll(f.cleared, { timeout: 10_000 }).toBe(true);

    const reopened = ManagedRuntime.make(
      testServices(join(f.directory, "data"), f.models, undefined, f.directory),
    );
    runtimes.push(reopened);
    const threads = await reopened.runPromise(ThreadService);
    await reopened.runPromise(threads.open(f.thread.id));
    const record = await reopened.runPromise(
      (await reopened.runPromise(RuntimeRegistryService)).acquire(f.thread.thread.sessionRef),
    );
    expect((await record.harness.snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))?.runGrants).toEqual(
      [],
    );
    f.agent.setResponses([tool("second"), fauxAssistantMessage("Done")]);
    await reopened.runPromise(threads.submit(f.thread.id, "New run after restart"));
    try {
      await expect
        .poll(async () => (await record.approvals.list()).length, { timeout: 15_000 })
        .toBe(1);
      expect(await f.subject()).toBe("first");
    } finally {
      await reopened.runPromise(threads.stop(f.thread.id));
    }
  } finally {
    f.release();
  }
}, 45_000);
