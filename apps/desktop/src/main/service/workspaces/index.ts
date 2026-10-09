import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { Context, DateTime, Effect, Layer } from "effect";
import { DesktopCatalogService } from "../catalog/index.ts";
import type { CatalogError } from "../catalog/json-store.ts";
import { adapter, DesktopServiceError } from "../errors.ts";
import type { WorkspaceMetadata } from "../../../shared/workspaces.ts";

export class WorkspaceService extends Context.Service<
  WorkspaceService,
  {
    list(projectId?: string): Effect.Effect<ReadonlyArray<WorkspaceMetadata>>;
    get(id: string): Effect.Effect<WorkspaceMetadata, DesktopServiceError>;
    validate(id: string): Effect.Effect<WorkspaceMetadata, DesktopServiceError>;
    register(
      projectId: string,
      cwd: string,
    ): Effect.Effect<WorkspaceMetadata, DesktopServiceError | CatalogError>;
  }
>()("eta/desktop/main/service/workspaces/WorkspaceService") {
  static readonly layer = Layer.effect(
    WorkspaceService,
    Effect.gen(function* () {
      const catalog = yield* DesktopCatalogService;
      const get = Effect.fn("WorkspaceService.get")(function* (id: string) {
        const workspace = (yield* catalog.read).workspaces.find((value) => value.id === id);
        if (!workspace)
          return yield* new DesktopServiceError({ code: "NotFound", message: "工作区不存在" });
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
        validate: Effect.fn("WorkspaceService.validate")(function* (id: string) {
          const workspace = yield* get(id);
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
        register: Effect.fn("WorkspaceService.register")(function* (
          projectId: string,
          cwd: string,
        ) {
          const state = yield* catalog.read;
          if (!state.projects.some((project) => project.id === projectId))
            return yield* new DesktopServiceError({ code: "NotFound", message: "项目不存在" });
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
        }),
      });
    }),
  );
}
