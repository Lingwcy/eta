import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { testServices } from "../../support/runtime.ts";
import { ProjectService } from "../../../src/service/projects/index.ts";
import { ThreadService } from "../../../src/service/threads/index.ts";
import { WorkspaceService } from "../../../src/service/workspaces/index.ts";
import { WorkspaceOwnershipService } from "../../../src/service/workspaces/ownership.ts";

const io = vi.hoisted(() => ({
  realpath: vi.fn<(typeof import("node:fs/promises"))["realpath"]>(),
  rm: vi.fn<(typeof import("node:fs/promises"))["rm"]>(),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  io.realpath.mockImplementation(fs.realpath);
  io.rm.mockImplementation(fs.rm);
  return { ...fs, realpath: io.realpath, rm: io.rm };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(child: boolean, kind: "project" | "worktree") {
  const directory = await mkdtemp(join(tmpdir(), "eta-temporary-ownership-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "ownership", models: [{ id: "one" }] }).provider);
  const runtime = ManagedRuntime.make(testServices(join(directory, "data"), models));
  cleanups.push(() => runtime.dispose());
  const threads = await runtime.runPromise(ThreadService);
  const workspaces = await runtime.runPromise(WorkspaceService);
  const projects = await runtime.runPromise(ProjectService);
  const ownership = await runtime.runPromise(WorkspaceOwnershipService);
  const thread = await runtime.runPromise(threads.create(null));
  const workspace = await runtime.runPromise(workspaces.get(thread.workspaceId!));
  const rootPath = child ? join(workspace.cwd, "adopted") : workspace.cwd;
  await mkdir(rootPath, { recursive: true });
  const file = join(rootPath, "keep.txt");
  await writeFile(file, "Adopted work");
  const projectPath = join(directory, "project");
  await mkdir(projectPath);
  const hostProject =
    kind === "worktree"
      ? await runtime.runPromise(projects.register({ rootPath: projectPath }))
      : undefined;
  const register = Effect.fnUntraced(function* () {
    return hostProject
      ? yield* workspaces.register(hostProject.id, rootPath)
      : yield* projects.register({ rootPath });
  });
  return {
    runtime,
    threads,
    workspaces,
    projects,
    ownership,
    thread,
    workspace,
    rootPath,
    file,
    register,
    hostProject,
  };
}

function nextOwnershipAttempt(ownership: WorkspaceOwnershipService["Service"]) {
  const attempted = Promise.withResolvers<void>();
  const coordinate = ownership.coordinate.bind(ownership);
  vi.spyOn(ownership, "coordinate").mockImplementation((action) => {
    attempted.resolve();
    return coordinate(action);
  });
  return attempted.promise;
}

const cases = (["project", "worktree"] as const).flatMap((kind) =>
  [false, true].map((child) => ({ kind, child })),
);

async function reached(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await expect.poll(() => done, { timeout: 5_000 }).toBe(true);
}

test.each(cases)(
  "registration admitted before cleanup preserves the adopted directory ($kind, child=$child)",
  async ({ child, kind }) => {
    const {
      runtime,
      projects,
      workspaces,
      threads,
      ownership,
      thread,
      workspace,
      rootPath,
      file,
      register,
    } = await fixture(child, kind);
    const validating = Promise.withResolvers<void>();
    const validated = Promise.withResolvers<void>();
    const removing = Promise.withResolvers<void>();
    const remove = Promise.withResolvers<void>();
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    io.realpath.mockImplementation(async (path, options) => {
      const result = await fs.realpath(path, options);
      if (path === rootPath) {
        validating.resolve();
        await validated.promise;
      }
      return result;
    });
    io.rm.mockImplementation(async (path, options) => {
      if (path === workspace.cwd) {
        removing.resolve();
        await remove.promise;
      }
      return fs.rm(path, options);
    });
    const registration = runtime.runPromise(register());
    let deletion: Promise<void> | undefined;
    try {
      await reached(validating.promise);
      const cleanupAttempt = nextOwnershipAttempt(ownership);
      deletion = runtime.runPromise(threads.remove(thread.id));
      // Old cleanup reaches rm; coordinated cleanup waits for the admitted registration.
      await reached(Promise.race([cleanupAttempt, removing.promise]));
      validated.resolve();
      const project = await registration;
      remove.resolve();
      await deletion;
      expect(await readFile(file, "utf8")).toBe("Adopted work");
      expect([
        ...(await runtime.runPromise(projects.list())),
        ...(await runtime.runPromise(workspaces.list())),
      ]).toContainEqual(project);
    } finally {
      validated.resolve();
      remove.resolve();
      await Promise.allSettled([registration, ...(deletion ? [deletion] : [])]);
      io.realpath.mockImplementation(fs.realpath);
      io.rm.mockImplementation(fs.rm);
    }
  },
  15_000,
);

test.each(cases)(
  "cleanup admitted before registration rejects the removed directory ($kind, child=$child)",
  async ({ child, kind }) => {
    const {
      runtime,
      projects,
      threads,
      ownership,
      thread,
      workspace,
      rootPath,
      register,
      hostProject,
    } = await fixture(child, kind);
    const removing = Promise.withResolvers<void>();
    const remove = Promise.withResolvers<void>();
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    io.rm.mockImplementation(async (path, options) => {
      if (path === workspace.cwd) {
        removing.resolve();
        await remove.promise;
      }
      return fs.rm(path, options);
    });
    const deletion = runtime.runPromise(threads.remove(thread.id));
    let registration: Promise<unknown> | undefined;
    try {
      await reached(removing.promise);
      const registrationAttempt = nextOwnershipAttempt(ownership);
      registration = runtime.runPromise(
        Effect.match(register(), {
          onFailure: (error) => error,
          onSuccess: () => "registered",
        }),
      );
      await reached(Promise.race([registrationAttempt, registration]));
      remove.resolve();
      await deletion;
      expect(await registration).toMatchObject(
        kind === "project" ? { reason: "PathUnavailable" } : { code: "WorkspaceUnavailable" },
      );
      expect(await runtime.runPromise(projects.list())).toEqual(hostProject ? [hostProject] : []);
      await expect(realpath(rootPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      remove.resolve();
      await Promise.allSettled([deletion, ...(registration ? [registration] : [])]);
      io.rm.mockImplementation(fs.rm);
    }
  },
  15_000,
);
