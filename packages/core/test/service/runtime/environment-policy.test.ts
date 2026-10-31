import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@eta/agent/env";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { testServices } from "../../support/runtime.ts";
import { CoreEnvironmentService } from "../../../src/service/environment.ts";
import { ProjectService } from "../../../src/service/projects/index.ts";
import { WorkspaceService } from "../../../src/service/workspaces/index.ts";
import { ThreadService } from "../../../src/service/threads/index.ts";
import { RuntimeRegistryService } from "../../../src/service/runtime/index.ts";
import { SandboxDoc } from "../../../src/service/runtime/sandbox.ts";
import { SandboxedExecutionEnv } from "../../../src/platform/sandbox/environment.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const cases = ["change", "revoke"]
  .flatMap((action) =>
    ["before-retirement", "after-retirement"].map((order) => ({ action, order })),
  )
  .concat([
    { action: "failed-change", order: "after-retirement" },
    { action: "failed-cleanup", order: "before-retirement" },
    { action: "overlapping-revokes", order: "after-retirement" },
  ]);

test.each(cases)(
  "$action retires an environment returned $order",
  async ({ action, order }) => {
    const directory = await mkdtemp(join(tmpdir(), "eta-environment-policy-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const cwd = join(directory, "project");
    await mkdir(cwd);
    const proof = join(cwd, "proof.txt");
    await writeFile(proof, "old worker proof");
    const provider = fauxProvider({ provider: "policy", models: [{ id: "one" }] });
    const models = createModels();
    models.setProvider(provider.provider);
    const runtime = ManagedRuntime.make(
      testServices(join(directory, "data"), models, undefined, directory),
    );
    cleanups.push(() => runtime.dispose());
    const threads = await runtime.runPromise(ThreadService);
    const project = await runtime.runPromise(
      (await runtime.runPromise(ProjectService)).register({ rootPath: cwd }),
    );
    const workspace = (
      await runtime.runPromise((await runtime.runPromise(WorkspaceService)).list(project.id))
    )[0]!;
    const thread = await runtime.runPromise(
      threads.create(workspace.id, undefined, {
        provider: "policy",
        modelId: "one",
        thinkingLevel: "off",
        sandboxMode: "danger-full-access",
      }),
    );
    const registry = await runtime.runPromise(RuntimeRegistryService);
    const record = await runtime.runPromise(registry.acquire(thread.thread.sessionRef));
    await record.revokeSandboxGrants();
    const environment = await runtime.runPromise(CoreEnvironmentService);
    const create = environment.executionEnvironment.bind(environment);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    const releaseMutation = Promise.withResolvers<void>();
    const mutationEntered = Promise.withResolvers<void>();
    const spawned: ExecutionEnv[] = [];
    let old: ExecutionEnv | undefined;
    let overlapping: Promise<void> | undefined;
    vi.spyOn(environment, "executionEnvironment").mockImplementation(async (...args) => {
      const env = await create(...args);
      spawned.push(env);
      if (old) return env;
      old = env;
      try {
        entered.resolve();
        await release.promise;
        return env;
      } finally {
        returned.resolve();
      }
    });
    let delivered = 0;
    const stop = await runtime.runPromise(
      threads.subscribe(
        thread.thread.id,
        () => {
          delivered++;
        },
        () => {},
      ),
    );
    try {
      await entered.promise;
      expect(old).toBeInstanceOf(SandboxedExecutionEnv);
      expect((await old!.readTextFile(proof, BACKGROUND_CONTEXT)).ok).toBe(true);
      if (order === "before-retirement") {
        release.resolve();
        await expect.poll(() => delivered, { timeout: 5000 }).toBeGreaterThan(0);
      }
      if (action === "change") {
        await runtime.runPromise(threads.configureSandbox(thread.thread.id, "read-only"));
      } else if (action === "failed-change") {
        vi.spyOn(record.conversation, "commit").mockImplementationOnce(async () => {
          throw new Error("Controlled policy commit failure");
        });
        await expect(
          runtime.runPromise(threads.configureSandbox(thread.thread.id, "read-only")),
        ).rejects.toThrow();
        // A failed retirement still admits a fresh scope using the unchanged durable policy.
        expect(await record.sandbox()).toMatchObject({
          mode: "danger-full-access",
          available: true,
        });
      } else if (action === "failed-cleanup") {
        vi.spyOn(old!, "cleanup").mockImplementationOnce(async () => {
          throw new Error("Controlled environment cleanup failure");
        });
        await expect(
          runtime.runPromise(threads.configureSandbox(thread.thread.id, "read-only")),
        ).rejects.toThrow();
      } else if (action === "overlapping-revokes") {
        const commit = record.conversation.commit.bind(record.conversation);
        vi.spyOn(record.conversation, "commit").mockImplementationOnce(async (...args) => {
          const result = await commit(...args);
          mutationEntered.resolve();
          await releaseMutation.promise;
          return result;
        });
        overlapping = record.revokeSandboxGrants();
        await mutationEntered.promise;
        await record.revokeSandboxGrants();
        // Completing the newer revocation must not reactivate the still-retiring scope.
        expect(await record.sandbox()).toMatchObject({ available: false });
        releaseMutation.resolve();
        await overlapping;
      } else {
        await record.revokeSandboxGrants();
      }
      expect((await record.harness.snapshot(SandboxDoc, BACKGROUND_CONTEXT))?.mode).toBe(
        action === "change" ? "read-only" : "danger-full-access",
      );
      const beforeOldReturn = spawned.length;
      release.resolve();
      await returned.promise;
      await expect
        .poll(
          async () => ({
            disposed: record.disposed,
            oldWorkerReadable: (await old!.readTextFile(proof, BACKGROUND_CONTEXT)).ok,
          }),
          { timeout: 3000 },
        )
        .toEqual({ disposed: false, oldWorkerReadable: action === "failed-cleanup" });
      if (action === "failed-change") {
        expect(await record.sandbox()).toMatchObject({ available: true });
        // Late old-key rejection must not evict the already usable replacement's cache entry.
        expect(spawned.length).toBe(beforeOldReturn);
      }
      await runtime.runPromise(threads.configureSandbox(thread.thread.id, "danger-full-access"));
      expect(await record.sandbox()).toMatchObject({ mode: "danger-full-access", available: true });
      expect(await readFile(proof, "utf8")).toBe("old worker proof");
      if (action === "failed-cleanup") {
        // A rejected cleanup must retain the handle for a later real teardown attempt.
        await runtime.dispose();
        expect((await old!.readTextFile(proof, BACKGROUND_CONTEXT)).ok).toBe(false);
      }
    } finally {
      stop();
      release.resolve();
      releaseMutation.resolve();
      await returned.promise;
      await overlapping;
      await old?.cleanup(BACKGROUND_CONTEXT);
    }
  },
  30_000,
);
