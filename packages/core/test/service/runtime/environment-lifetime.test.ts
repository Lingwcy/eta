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
import { SandboxedExecutionEnv } from "../../../src/platform/sandbox/environment.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each(["before-close", "after-close"])(
  "a real environment returned %s cannot remain usable after runtime disposal",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "eta-environment-lifetime-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const cwd = join(directory, "project");
    await mkdir(cwd);
    const proof = join(cwd, "proof.txt");
    await writeFile(proof, "worker read proof");
    const provider = fauxProvider({ provider: "lifetime", models: [{ id: "one" }] });
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
        provider: "lifetime",
        modelId: "one",
        thinkingLevel: "off",
        sandboxMode: "danger-full-access",
      }),
    );
    const registry = await runtime.runPromise(RuntimeRegistryService);
    const record = await runtime.runPromise(registry.acquire(thread.thread.sessionRef));
    // Remove the idle status environment so the next ordinary snapshot opens one asynchronously.
    await record.revokeSandboxGrants();
    const environment = await runtime.runPromise(CoreEnvironmentService);
    const create = environment.executionEnvironment.bind(environment);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let actual: ExecutionEnv | undefined;
    const opened = Promise.withResolvers<void>();
    vi.spyOn(environment, "executionEnvironment").mockImplementation(async (...args) => {
      try {
        actual = await create(...args);
        entered.resolve();
        await release.promise;
        return actual;
      } finally {
        opened.resolve();
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
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      expect(actual).toBeInstanceOf(SandboxedExecutionEnv);
      expect((await actual!.readTextFile(proof, BACKGROUND_CONTEXT)).ok).toBe(true);
      if (mode === "before-close") {
        release.resolve();
        await expect.poll(() => delivered, { timeout: 5000 }).toBeGreaterThan(0);
      }
      let closed = false;
      closing = runtime.dispose().then(() => {
        closed = true;
      });
      await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
      const deliveredAtClose = delivered;
      release.resolve();
      await opened.promise;
      expect(actual).toBeDefined();
      await expect
        .poll(
          async () => ({
            disposed: record.disposed,
            workerStillReadable: (await actual!.readTextFile(proof, BACKGROUND_CONTEXT)).ok,
          }),
          { timeout: 3000 },
        )
        .toEqual({ disposed: true, workerStillReadable: false });
      expect(delivered).toBe(deliveredAtClose);
      expect(await readFile(proof, "utf8")).toBe("worker read proof");
    } finally {
      stop();
      release.resolve();
      await opened.promise;
      await closing;
      await actual?.cleanup(BACKGROUND_CONTEXT);
    }
  },
  20_000,
);
