import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { testServices, TestSettings } from "../../support/runtime.ts";
import { ProjectService } from "../../../src/service/projects/index.ts";
import { WorkspaceService } from "../../../src/service/workspaces/index.ts";
import { ThreadService } from "../../../src/service/threads/index.ts";
import { RuntimeRegistryService } from "../../../src/service/runtime/index.ts";
import { ThreadTitleService } from "../../../src/service/titles/index.ts";
import { FileChangeService } from "../../../src/service/file-changes/index.ts";
import { CoreError } from "../../../src/service/errors.ts";
import { ApprovalsDoc } from "../../../src/service/runtime/approval-doc.ts";
import { SubagentsDoc } from "../../../src/agent/extension/subagent/index.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-runtime-startup-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "startup-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "startup-test",
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
  const registry = await runtime.runPromise(RuntimeRegistryService);
  const settings = await runtime.runPromise(TestSettings);
  const title = await runtime.runPromise(ThreadTitleService);
  const fileChanges = await runtime.runPromise(FileChangeService);
  return { runtime, provider, workspace, threads, registry, settings, title, fileChanges };
}

test.each(["before-title", "after-title", "unsubscribe-error", "healthy"])(
  "runtime startup releases settings ownership after %s",
  async (mode) => {
    const { runtime, provider, workspace, threads, registry, settings, title, fileChanges } =
      await fixture();
    const active = new Set<() => void>();
    const subscribe = settings.subscribe.bind(settings);
    let rejectUnsubscribe = mode === "unsubscribe-error";
    vi.spyOn(settings, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      active.add(listener);
      return () => {
        active.delete(listener);
        unsubscribe();
        if (rejectUnsubscribe) {
          rejectUnsubscribe = false;
          throw new Error("Controlled unsubscribe acknowledgement failure");
        }
      };
    });
    const watch = title.watch.bind(title);
    let failed: Parameters<typeof title.watch>[0] | undefined;
    const error = new CoreError({
      code: "StorageUnavailable",
      message: "Controlled startup title failure",
    });
    vi.spyOn(title, "watch").mockImplementationOnce((record) => {
      if (mode === "healthy") return watch(record);
      failed = record;
      return mode === "after-title"
        ? watch(record).pipe(Effect.andThen(Effect.fail(error)))
        : Effect.fail(error);
    });
    const recorderSpy = vi.spyOn(fileChanges, "recorder");
    if (mode !== "healthy") {
      await expect(runtime.runPromise(threads.create(workspace.id))).rejects.toMatchObject({
        code: error.code,
        message: error.message,
      });
      expect(failed).toBeDefined();
      await expect(
        Promise.resolve().then(() => failed!.harness.snapshot(ApprovalsDoc, BACKGROUND_CONTEXT)),
      ).rejects.toThrow(/closed/i);
      expect({ disposed: failed!.disposed, subscriptions: active.size }).toEqual({
        disposed: true,
        subscriptions: 0,
      });
      const failedRef = recorderSpy.mock.calls[0]?.[0];
      const failedRecorder = recorderSpy.mock.results[0];
      expect(failedRef).toBeDefined();
      expect(failedRecorder?.type).toBe("return");
      if (!failedRef || failedRecorder?.type !== "return")
        throw new Error("Failed runtime did not create a file-change recorder");
      expect(fileChanges.recorder(failedRef)).not.toBe(failedRecorder.value);
      await fileChanges.release(failedRef);
    }
    const created = await runtime.runPromise(threads.create(workspace.id));
    const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
    expect(active.size).toBe(1);
    const revision =
      (await record.harness.snapshot(SubagentsDoc, BACKGROUND_CONTEXT))?.revision ?? 0;
    await runtime.runPromise(settings.update({ approvalReviewer: { mode: "user" } }));
    await expect
      .poll(
        async () => (await record.harness.snapshot(SubagentsDoc, BACKGROUND_CONTEXT))?.revision,
        { timeout: 5000 },
      )
      .toBeGreaterThan(revision);
    provider.setResponses([fauxAssistantMessage("Healthy startup after failure")]);
    const admission = await runtime.runPromise(
      threads.submit(created.id, "Run after startup check"),
    );
    await expect
      .poll(
        async () =>
          (await runtime.runPromise(threads.operation(created.id, admission.operationId))).status,
        { timeout: 5000 },
      )
      .toBe("completed");
    await runtime.dispose();
    expect(active.size).toBe(0);
  },
  15_000,
);
