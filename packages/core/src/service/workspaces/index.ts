import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Context, DateTime, Effect, Layer } from "effect";
import { CatalogService } from "../catalog/index.ts";
import type { CatalogError } from "../catalog/json-store.ts";
import { adapter, CoreError } from "../errors.ts";
import type { WorkspaceMetadata } from "../../shared/workspaces.ts";
import { WorkspaceAccessService } from "../git/workspace-access.ts";
import { AppPathsService } from "../../platform/app-paths.ts";
import { WorkspaceOwnershipService } from "./ownership.ts";

export class WorkspaceService extends Context.Service<
  WorkspaceService,
  {
    list(projectId?: string): Effect.Effect<ReadonlyArray<WorkspaceMetadata>>;
    get(id: string): Effect.Effect<WorkspaceMetadata, CoreError>;
    validate(id: string): Effect.Effect<WorkspaceMetadata, CoreError>;
    temporary(requestId?: string): Effect.Effect<WorkspaceMetadata, CoreError | CatalogError>;
    register(
      projectId: string,
      cwd: string,
    ): Effect.Effect<WorkspaceMetadata, CoreError | CatalogError>;
  }
>()("eta/core/service/workspaces/WorkspaceService") {
  static readonly layer = Layer.effect(
    WorkspaceService,
    Effect.gen(function* () {
      const catalog = yield* CatalogService;
      const access = yield* WorkspaceAccessService;
      const paths = yield* AppPathsService;
      const ownership = yield* WorkspaceOwnershipService;
      const get = Effect.fn("WorkspaceService.get")(function* (id: string) {
        const workspace = (yield* catalog.read).workspaces.find((value) => value.id === id);
        if (!workspace) return yield* new CoreError({ code: "NotFound", message: "工作区不存在" });
        return workspace;
      });
      return WorkspaceService.of({
        list: (projectId) =>
          catalog.read.pipe(
            Effect.map((state) =>
              state.workspaces.filter((value) => !projectId || value.projectId === projectId),
            ),
          ),
        get,
        temporary: Effect.fn("WorkspaceService.temporary")(function* (requestId?: string) {
          const id = requestId
            ? createHash("sha256").update(requestId).digest("hex")
            : randomUUID();
          const existing = (yield* catalog.read).workspaces.find(
            (value) =>
              requestId !== undefined &&
              value.kind === "temporary" &&
              value.requestId === requestId,
          );
          if (existing) return existing;
          const cwd = yield* adapter("无法创建临时工作区", async () => {
            await mkdir(paths.temporaryWorkspacesRoot, { recursive: true });
            const root = join(
              await realpath(dirname(paths.temporaryWorkspacesRoot)),
              basename(paths.temporaryWorkspacesRoot),
            );
            if ((await realpath(paths.temporaryWorkspacesRoot)) !== root)
              throw new Error("Temporary workspace root moved or substituted");
            // An adopted directory can outlive its original temporary workspace.
            const directory = await mkdtemp(join(root, `${id}-`));
            if ((await realpath(directory)) !== directory)
              throw new Error("Temporary workspace moved or substituted");
            return directory;
          });
          let result: WorkspaceMetadata = {
            id: randomUUID(),
            projectId: null,
            kind: "temporary",
            cwd,
            createdAt: DateTime.toEpochMillis(yield* DateTime.now),
            ...(requestId ? { requestId } : {}),
          };
          yield* catalog.update((state) => {
            const existing = state.workspaces.find(
              (value) => value.kind === "temporary" && value.cwd === cwd,
            );
            if (existing) {
              result = existing;
              return state;
            }
            return { ...state, workspaces: [...state.workspaces, result] };
          });
          return result;
        }),
        validate: Effect.fn("WorkspaceService.validate")(function* (id: string) {
          const workspace = yield* get(id);
          const reason = yield* access.reason(workspace.cwd);
          if (reason)
            return yield* new CoreError({ code: "WorkspaceUnavailable", message: reason });
          yield* adapter(
            "工作区目录不可用；历史仍可查看",
            async () => {
              if (
                !(await stat(workspace.cwd)).isDirectory() ||
                (await realpath(workspace.cwd)) !== workspace.cwd
              )
                throw new Error("Workspace moved or substituted");
            },
            "WorkspaceUnavailable",
          );
          return workspace;
        }),
        register: Effect.fn("WorkspaceService.register")(
          function* (projectId: string, cwd: string) {
            const state = yield* catalog.read;
            if (!state.projects.some((project) => project.id === projectId))
              return yield* new CoreError({ code: "NotFound", message: "项目不存在" });
            const canonical = yield* adapter(
              "无法访问工作区目录",
              async () => {
                const path = await realpath(cwd);
                if (!(await stat(path)).isDirectory()) throw new Error("Not a directory");
                return path;
              },
              "WorkspaceUnavailable",
            );
            let result: WorkspaceMetadata = {
              id: randomUUID(),
              projectId,
              cwd: canonical,
              kind: "worktree",
              createdAt: DateTime.toEpochMillis(yield* DateTime.now),
            };
            yield* catalog.update((state) => {
              const existing = state.workspaces.find(
                (value) => value.projectId === projectId && value.cwd === canonical,
              );
              if (existing) {
                result = existing;
                return state;
              }
              return { ...state, workspaces: [...state.workspaces, result] };
            });
            return result;
          },
          (action) => ownership.coordinate(action),
        ),
      });
    }),
  );
}
