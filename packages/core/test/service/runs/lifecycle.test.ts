import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { testServices } from "../../support/runtime.ts";
import { ProjectService } from "../../../src/service/projects/index.ts";
import { WorkspaceService } from "../../../src/service/workspaces/index.ts";
import { ThreadService } from "../../../src/service/threads/index.ts";
import { RuntimeRegistryService } from "../../../src/service/runtime/index.ts";
import { ApprovalsDoc } from "../../../src/service/runtime/approval-doc.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-expiry-lifetime-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "expiry-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "expiry-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const models = createModels();
  models.setProvider({
    ...provider.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? titles.provider.streamSimple(model, context, options)
        : provider.provider.streamSimple(model, context, options),
  });
  const runtime = ManagedRuntime.make(
    testServices(join(directory, "data"), models, undefined, directory),
  );
  cleanups.push(() => runtime.dispose());
  const project = await runtime.runPromise(
    (await runtime.runPromise(ProjectService)).register({ rootPath: cwd }),
  );
  const workspace = (
    await runtime.runPromise((await runtime.runPromise(WorkspaceService)).list(project.id))
  )[0]!;
  const threads = await runtime.runPromise(ThreadService);
  const thread = await runtime.runPromise(threads.create(workspace.id));
  const registry = await runtime.runPromise(RuntimeRegistryService);
  const record = await runtime.runPromise(registry.acquire(thread.thread.sessionRef));
  return { runtime, provider, threads, thread, registry, record };
}

test.each(["closed-before-expiry", "closed-during-expiry", "active-error", "active-success"])(
  "idle grant expiry respects its runtime lifetime: %s",
  async (mode) => {
    const { runtime, provider, threads, thread, registry, record } = await fixture();
    const logs: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((...values) => {
      logs.push(values.map(String).join(" "));
    });
    const idle = record.conversation.waitForIdle.bind(record.conversation);
    const expire = record.approvals.expireRunGrants.bind(record.approvals);
    const release = Promise.withResolvers<void>();
    let entered = false;
    let crossed = false;
    let expirySettled = false;
    let expiryFailure: unknown;
    vi.spyOn(record.conversation, "waitForIdle").mockImplementation(async (...args) => {
      await idle(...args);
      if (mode === "closed-before-expiry" && !entered) {
        entered = true;
        await release.promise;
        crossed = true;
      }
    });
    vi.spyOn(record.approvals, "expireRunGrants").mockImplementation(async (...args) => {
      if (mode !== "closed-before-expiry") {
        entered = true;
        await release.promise;
      }
      try {
        await expire(...args);
        if (mode === "active-error") throw new Error("Controlled active expiry failure");
      } catch (error) {
        expiryFailure = error;
        throw error;
      } finally {
        expirySettled = true;
      }
    });
    try {
      provider.setResponses([fauxAssistantMessage("Completed ordinary work")]);
      const admission = await runtime.runPromise(threads.submit(thread.id, "Run ordinary work"));
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      expect(
        (await runtime.runPromise(threads.operation(thread.id, admission.operationId))).status,
      ).toBe("completed");
      const closed = mode.startsWith("closed-");
      if (closed) {
        await runtime.runPromise(registry.close(thread.thread.sessionRef));
        expect(record.disposed).toBe(true);
        await expect(
          Promise.resolve().then(() => record.harness.snapshot(ApprovalsDoc, BACKGROUND_CONTEXT)),
        ).rejects.toThrow(/closed/i);
      } else {
        const task = (
          await record.storage.scanTasks(
            { conversationId: record.conversation.id, status: "terminal" },
            1,
            undefined,
            BACKGROUND_CONTEXT,
          )
        ).items[0]!;
        await record.conversation.commit(async (tx) => {
          (await tx.doc(ApprovalsDoc)).runGrants = [
            {
              id: "legacy-expiry-proof",
              taskId: task.id,
              conversationId: record.conversation.id,
              revision: 1,
              readableRoots: [],
              writableRoots: [],
              by: "user",
            },
          ];
        }, BACKGROUND_CONTEXT);
        expect(
          (await record.harness.snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))?.runGrants,
        ).toHaveLength(1);
      }
      release.resolve();
      await expect
        .poll(() => (mode === "closed-before-expiry" ? crossed : expirySettled), { timeout: 5000 })
        .toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const errors = logs.filter(
        (line) =>
          line.includes("Session is closed") || line.includes("Controlled active expiry failure"),
      );
      if (mode === "active-error")
        expect(errors).toEqual([expect.stringContaining("Controlled active expiry failure")]);
      else expect(errors).toEqual([]);
      if (mode === "closed-before-expiry") expect(expirySettled).toBe(false);
      if (mode === "closed-during-expiry") {
        expect(expiryFailure).toBeInstanceOf(Error);
        expect(String(expiryFailure)).toContain("Session is closed");
      }
      if (!closed) {
        await runtime.runPromise(registry.close(thread.thread.sessionRef));
        const reopened = await runtime.runPromise(registry.acquire(thread.thread.sessionRef));
        expect(
          (await reopened.harness.snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))?.runGrants,
        ).toEqual([]);
      }
    } finally {
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      consoleLog.mockRestore();
    }
  },
  15_000,
);
