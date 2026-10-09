import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { AppPathsService } from "../../../platform/app-paths.ts";
import { DesktopCatalogService } from "../index.ts";
import { CatalogStorageError, CatalogStoreService } from "../json-store.ts";
import { catalogFixture } from "./test-fixtures.ts";
import type { CatalogState } from "../../../../shared/catalog.ts";

const directories: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<DesktopCatalogService, unknown>[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runtimeFor(storeLayer: Layer.Layer<CatalogStoreService>) {
  const runtime = ManagedRuntime.make(DesktopCatalogService.layer.pipe(Layer.provide(storeLayer)));
  runtimes.push(runtime);
  return runtime;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eta-catalog-service-"));
  directories.push(directory);
  const storeLayer = CatalogStoreService.layer.pipe(
    Layer.provide(AppPathsService.layer(directory)),
  );
  const runtime = runtimeFor(storeLayer);
  const catalog = await runtime.runPromise(DesktopCatalogService);
  return { catalog, runtime, storeLayer };
}

test("persists a related set of records together and reads them after reopening", async () => {
  const { catalog, runtime, storeLayer } = await setup();
  await runtime.runPromise(catalog.update(() => catalogFixture()));
  await runtime.dispose();
  const reopened = runtimeFor(storeLayer);
  const other = await reopened.runPromise(DesktopCatalogService);
  expect(await reopened.runPromise(other.read)).toEqual(catalogFixture());
});

test("catalog subscribers see adopted state after successful persistence and can unsubscribe", async () => {
  const { catalog, runtime } = await setup();
  const observations: Promise<CatalogState>[] = [];
  const stop = catalog.subscribe(() => observations.push(runtime.runPromise(catalog.read)));
  await runtime.runPromise(catalog.update(() => catalogFixture()));
  expect(await Promise.all(observations)).toEqual([catalogFixture()]);
  await runtime.runPromise(Effect.flip(catalog.update((state) => ({ ...state, workspaces: [] }))));
  expect(observations).toHaveLength(1);
  stop();
  await runtime.runPromise(catalog.update(() => catalogFixture()));
  expect(observations).toHaveLength(1);
});

test("serializes concurrent transformations without losing updates", async () => {
  const { catalog, runtime, storeLayer } = await setup();
  await runtime.runPromise(
    Effect.all(
      Array.from({ length: 20 }, (_, index) =>
        catalog.update((state) => ({
          ...state,
          projects: [
            ...state.projects,
            {
              id: `project-${index}`,
              environmentId: "local",
              name: `Project ${index}`,
              rootPath: `/repo/${index}`,
              createdAt: index,
            },
          ],
        })),
      ),
      { concurrency: "unbounded" },
    ),
  );
  const state = await runtime.runPromise(catalog.read);
  expect(new Set(state.projects.map(({ id }) => id)).size).toBe(20);
  const reopened = runtimeFor(storeLayer);
  const other = await reopened.runPromise(DesktopCatalogService);
  expect(await reopened.runPromise(other.read)).toEqual(state);
});

test("rejects dangling references and permits archive, unarchive and removal through updates", async () => {
  const { catalog, runtime } = await setup();
  await runtime.runPromise(catalog.update(() => catalogFixture()));
  const error = await runtime.runPromise(
    Effect.flip(catalog.update((state) => ({ ...state, workspaces: [] }))),
  );
  expect(error).toMatchObject({ _tag: "CatalogValidationError", reason: "InvalidRelations" });
  expect(await runtime.runPromise(catalog.read)).toEqual(catalogFixture());
  await runtime.runPromise(
    catalog.update((state) => ({
      ...state,
      threads: state.threads.map((thread) => ({ ...thread, archivedAt: 2 })),
    })),
  );
  expect((await runtime.runPromise(catalog.read)).threads[0]!.archivedAt).toBe(2);
  await runtime.runPromise(
    catalog.update((state) => ({
      ...state,
      threads: state.threads.map(({ archivedAt: _archivedAt, ...thread }) => thread),
    })),
  );
  expect((await runtime.runPromise(catalog.read)).threads[0]!.archivedAt).toBeUndefined();
  await runtime.runPromise(catalog.update((state) => ({ ...state, threads: [] })));
  expect((await runtime.runPromise(catalog.read)).threads).toEqual([]);
});

test("a failed save leaves memory unchanged and does not block subsequent updates", async () => {
  let fail = true;
  const runtime = runtimeFor(
    Layer.succeed(
      CatalogStoreService,
      CatalogStoreService.of({
        load: Effect.succeed(catalogFixture()),
        save: () =>
          Effect.suspend(() =>
            fail
              ? Effect.fail(
                  new CatalogStorageError({
                    operation: "write",
                    path: "/catalog.json",
                    cause: "test",
                    message: "Write failed",
                  }),
                )
              : Effect.void,
          ),
      }),
    ),
  );
  const catalog = await runtime.runPromise(DesktopCatalogService);
  await runtime.runPromise(Effect.flip(catalog.update((state) => ({ ...state, threads: [] }))));
  expect(await runtime.runPromise(catalog.read)).toEqual(catalogFixture());
  fail = false;
  await runtime.runPromise(catalog.update((state) => ({ ...state, threads: [] })));
  expect((await runtime.runPromise(catalog.read)).threads).toEqual([]);
});

test("does not expose mutable references from reads, transforms or update results", async () => {
  const { catalog, runtime } = await setup();
  const input = catalogFixture();
  const result = await runtime.runPromise(catalog.update(() => input));
  const read = await runtime.runPromise(catalog.read);
  result.threads[0]!.sessionRef.metadata.cwd = "/changed";
  read.threads[0]!.sessionRef.metadata.cwd = "/changed";
  input.threads[0]!.sessionRef.metadata.cwd = "/changed";
  expect(await runtime.runPromise(catalog.read)).toEqual(catalogFixture());
});

test("finishes persistence and publication when the caller cancels during a save", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let finishSave!: () => void;
  const finish = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  let persisted: CatalogState = catalogFixture();
  const runtime = runtimeFor(
    Layer.succeed(
      CatalogStoreService,
      CatalogStoreService.of({
        load: Effect.succeed(persisted),
        save: (next) =>
          Effect.promise(async () => {
            markStarted();
            await finish;
            persisted = structuredClone(next);
          }),
      }),
    ),
  );
  const catalog = await runtime.runPromise(DesktopCatalogService);
  const controller = new AbortController();
  const updating = runtime
    .runPromise(
      catalog.update((state) => ({ ...state, threads: [] })),
      {
        signal: controller.signal,
      },
    )
    .then(
      () => "completed",
      () => "interrupted",
    );
  await started;
  controller.abort();
  finishSave();
  await updating;
  expect(persisted.threads).toEqual([]);
  expect(await runtime.runPromise(catalog.read)).toEqual(persisted);
});
