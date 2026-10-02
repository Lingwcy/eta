import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { AppPathsService } from "../../../platform/app-paths.ts";
import { DesktopCatalogService } from "../../catalog/index.ts";
import { CatalogStorageError, CatalogStoreService } from "../../catalog/json-store.ts";
import { ProjectService } from "../index.ts";

const directories: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<ProjectService | DesktopCatalogService, unknown>[] =
  [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function makeRuntime(storeLayer: Layer.Layer<CatalogStoreService>) {
  const catalogLayer = DesktopCatalogService.layer.pipe(Layer.provide(storeLayer));
  const runtime = ManagedRuntime.make(ProjectService.layer.pipe(Layer.provideMerge(catalogLayer)));
  runtimes.push(runtime);
  return runtime;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eta-project-service-"));
  directories.push(directory);
  const rootPath = join(directory, "repository");
  await mkdir(rootPath);
  const storeLayer = CatalogStoreService.layer.pipe(
    Layer.provide(AppPathsService.layer(join(directory, "data"))),
  );
  const runtime = makeRuntime(storeLayer);
  const projects = await runtime.runPromise(ProjectService);
  const catalog = await runtime.runPromise(DesktopCatalogService);
  return { directory, rootPath, storeLayer, runtime, projects, catalog };
}

test("registers a project and its default workspace together and persists both across reopening", async () => {
  const { rootPath, runtime, projects, catalog, storeLayer } = await setup();
  expect(await runtime.runPromise(projects.list())).toEqual([]);
  const project = await runtime.runPromise(projects.register({ rootPath, name: "  Eta  " }));
  expect(project).toMatchObject({
    name: "Eta",
    environmentId: "local",
    rootPath: await realpath(rootPath),
  });
  expect(project.createdAt).toBeGreaterThan(0);
  const state = await runtime.runPromise(catalog.read);
  expect(state.projects).toEqual([project]);
  expect(state.workspaces).toEqual([
    {
      id: expect.any(String),
      projectId: project.id,
      cwd: project.rootPath,
      kind: "project-root",
      createdAt: project.createdAt,
    },
  ]);
  expect(state.workspaces[0]!.id).not.toBe(project.id);
  expect(state.threads).toEqual([]);
  await runtime.dispose();
  const reopened = makeRuntime(storeLayer);
  const other = await reopened.runPromise(ProjectService);
  expect(await reopened.runPromise(other.get(project.id))).toEqual(project);
  const otherCatalog = await reopened.runPromise(DesktopCatalogService);
  expect(await reopened.runPromise(otherCatalog.read)).toEqual(state);
});

test("defaults the project name to the canonical directory name", async () => {
  const { rootPath, runtime, projects } = await setup();
  const project = await runtime.runPromise(projects.register({ rootPath }));
  expect(project.name).toBe(basename(await realpath(rootPath)));
});

test("repeated registration returns the existing project without changing its name or workspace", async () => {
  const { rootPath, runtime, projects, catalog } = await setup();
  const first = await runtime.runPromise(projects.register({ rootPath, name: "Original" }));
  const second = await runtime.runPromise(
    projects.register({ rootPath: join(rootPath, "."), name: "Replacement" }),
  );
  expect(second).toEqual(first);
  const state = await runtime.runPromise(catalog.read);
  expect(state.projects).toHaveLength(1);
  expect(state.workspaces).toHaveLength(1);
});

test("concurrent registrations return one project and create one default workspace", async () => {
  const { rootPath, runtime, projects, catalog } = await setup();
  const results = await runtime.runPromise(
    Effect.all(
      Array.from({ length: 10 }, () => projects.register({ rootPath })),
      { concurrency: "unbounded" },
    ),
  );
  expect(new Set(results.map(({ id }) => id)).size).toBe(1);
  const state = await runtime.runPromise(catalog.read);
  expect(state.projects).toHaveLength(1);
  expect(state.workspaces).toHaveLength(1);
});

test("symbolic links and the original directory resolve to the same project", async () => {
  const { directory, rootPath, runtime, projects } = await setup();
  const alias = join(directory, "alias");
  await symlink(rootPath, alias, "dir");
  const first = await runtime.runPromise(projects.register({ rootPath: alias }));
  expect(await runtime.runPromise(projects.register({ rootPath }))).toEqual(first);
  expect(first.rootPath).toBe(await realpath(rootPath));
});

test("unavailable paths and regular files cannot create catalog records", async () => {
  const { directory, runtime, projects, catalog } = await setup();
  const missing = join(directory, "missing");
  expect(
    await runtime.runPromise(Effect.flip(projects.register({ rootPath: missing }))),
  ).toMatchObject({ reason: "PathUnavailable", rootPath: missing });
  const file = join(directory, "file.txt");
  await writeFile(file, "content");
  expect(
    await runtime.runPromise(Effect.flip(projects.register({ rootPath: file }))),
  ).toMatchObject({ reason: "NotDirectory" });
  expect(await runtime.runPromise(catalog.read)).toEqual({
    projects: [],
    workspaces: [],
    threads: [],
  });
});

test("empty paths and blank names return input errors", async () => {
  const { rootPath, runtime, projects } = await setup();
  expect(await runtime.runPromise(Effect.flip(projects.register({ rootPath: "" })))).toMatchObject({
    reason: "InvalidInput",
  });
  expect(
    await runtime.runPromise(Effect.flip(projects.register({ rootPath, name: "  " }))),
  ).toMatchObject({ reason: "InvalidInput" });
});

test("list and get remain available when a registered directory moves away", async () => {
  const { rootPath, runtime, projects } = await setup();
  const project = await runtime.runPromise(projects.register({ rootPath }));
  await rm(rootPath, { recursive: true });
  expect(await runtime.runPromise(projects.list())).toEqual([project]);
  expect(await runtime.runPromise(projects.get(project.id))).toEqual(project);
  expect(await runtime.runPromise(Effect.flip(projects.get("missing")))).toMatchObject({
    reason: "NotFound",
    projectId: "missing",
  });
});

test("a failed catalog save publishes neither the project nor its default workspace", async () => {
  const { rootPath } = await setup();
  const runtime = makeRuntime(
    Layer.succeed(
      CatalogStoreService,
      CatalogStoreService.of({
        load: Effect.succeed({ projects: [], workspaces: [], threads: [] }),
        save: () =>
          Effect.fail(
            new CatalogStorageError({
              operation: "write",
              path: "/catalog.json",
              cause: "test",
              message: "Write failed",
            }),
          ),
      }),
    ),
  );
  const projects = await runtime.runPromise(ProjectService);
  expect(await runtime.runPromise(Effect.flip(projects.register({ rootPath })))).toMatchObject({
    _tag: "CatalogStorageError",
  });
  const catalog = await runtime.runPromise(DesktopCatalogService);
  expect(await runtime.runPromise(catalog.read)).toEqual({
    projects: [],
    workspaces: [],
    threads: [],
  });
});
