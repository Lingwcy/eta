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
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-runtime-close-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "runtime-close-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "runtime-close-test",
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

test.each(["first", "second", "both", "none"])(
  "runtime close drains real resources and allows reopen when watch failure=%s",
  async (failure) => {
    const { runtime, provider, threads, thread, registry, record } = await fixture();
    provider.setResponses([
      fauxAssistantMessage("Before close"),
      fauxAssistantMessage("After reopen"),
    ]);
    const first = await runtime.runPromise(threads.submit(thread.id, "Initial work"));
    await expect
      .poll(
        async () =>
          (await runtime.runPromise(threads.operation(thread.id, first.operationId))).status,
        { timeout: 5000 },
      )
      .toBe("completed");
    await expect.poll(() => record.running).toBe(false);
    const watches = await Promise.all([
      record.conversation.watch(BACKGROUND_CONTEXT),
      record.conversation.watch(BACKGROUND_CONTEXT),
    ]);
    const stopped: number[] = [];
    watches.forEach((watch, index) => {
      record.watches.add(watch);
      const stop = watch.stop.bind(watch);
      vi.spyOn(watch, "stop").mockImplementationOnce(async () => {
        const end = await stop();
        stopped.push(index);
        if (failure === "both" || failure === (index === 0 ? "first" : "second"))
          throw new Error("Controlled watch cleanup failure " + index);
        return end;
      });
    });
    if (failure === "none") await runtime.runPromise(registry.close(thread.thread.sessionRef));
    else
      await expect(
        runtime.runPromise(registry.close(thread.thread.sessionRef)),
      ).rejects.toMatchObject({
        code: "StorageUnavailable",
        message: "无法关闭会话运行资源",
      });
    expect(record.disposed).toBe(true);
    expect(stopped.toSorted()).toEqual([0, 1]);
    const oldSession = await Promise.resolve()
      .then(() => record.harness.snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))
      .then(
        () => "open",
        (error: unknown) => {
          expect(String(error)).toMatch(/closed/i);
          return "closed";
        },
      );
    const cached = await runtime.runPromise(registry.peek(thread.thread.sessionRef));
    expect({ oldSession, cachedDisposed: cached?.disposed }).toEqual({
      oldSession: "closed",
      cachedDisposed: undefined,
    });
    const reopened = await runtime.runPromise(registry.acquire(thread.thread.sessionRef));
    expect(reopened).not.toBe(record);
    expect(reopened.disposed).toBe(false);
    const second = await runtime.runPromise(threads.submit(thread.id, "Work after failed cleanup"));
    await expect
      .poll(
        async () =>
          (await runtime.runPromise(threads.operation(thread.id, second.operationId))).status,
        { timeout: 5000 },
      )
      .toBe("completed");
    const snapshot = await runtime.runPromise(threads.open(thread.id));
    expect(
      snapshot.snapshot.transcript.filter(({ message }) => message.role === "user"),
    ).toHaveLength(2);
  },
  15_000,
);
