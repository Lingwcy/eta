import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { DesktopCatalogService } from "../catalog/index.ts";
import type { CatalogError } from "../catalog/json-store.ts";
import type { ProjectMetadata, RegisterProjectInput } from "./type.ts";

export class ProjectError extends Schema.TaggedError<ProjectError>()("ProjectError", {
  reason: Schema.Literals(["InvalidInput", "PathUnavailable", "NotDirectory", "NotFound"]),
  message: Schema.String,
  rootPath: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class ProjectService extends Context.Service<
  ProjectService,
  {
    register(
      input: RegisterProjectInput,
    ): Effect.Effect<ProjectMetadata, ProjectError | CatalogError>;
    list(): Effect.Effect<ReadonlyArray<ProjectMetadata>>;
    get(projectId: string): Effect.Effect<ProjectMetadata, ProjectError>;
  }
>()("eta/desktop/main/service/projects/ProjectService") {
  static readonly layer = Layer.effect(
    ProjectService,
    Effect.gen(function* () {
      const catalog = yield* DesktopCatalogService;
      return make(catalog);
    }),
  );
}

const decodeInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    rootPath: Schema.NonEmptyString,
    name: Schema.optionalKey(
      Schema.NonEmptyString.check(
        Schema.makeFilter((name) => name.trim().length > 0, {
          message: "Project name must not be blank",
        }),
      ),
    ),
  }),
);

function make(catalog: DesktopCatalogService["Service"]) {
  const register = Effect.fn("ProjectService.register")(function* (
    input: RegisterProjectInput,
  ): Effect.fn.Return<ProjectMetadata, ProjectError | CatalogError> {
    const validated = yield* decodeInput(input).pipe(
      Effect.mapError(
        (error) => new ProjectError({ reason: "InvalidInput", message: error.message }),
      ),
    );
    const { rootPath, isDirectory } = yield* Effect.tryPromise({
      try: async () => {
        const rootPath = await realpath(validated.rootPath);
        const info = await stat(rootPath);
        return { rootPath, isDirectory: info.isDirectory() };
      },
      catch: (cause) =>
        new ProjectError({
          reason: "PathUnavailable",
          rootPath: validated.rootPath,
          cause,
          message: `Cannot access project directory ${validated.rootPath}.`,
        }),
    });
    if (!isDirectory) {
      return yield* new ProjectError({
        reason: "NotDirectory",
        rootPath,
        message: `Project path ${rootPath} is not a directory.`,
      });
    }

    const createdAt = DateTime.toEpochMillis(yield* DateTime.now);
    const project: ProjectMetadata = {
      id: randomUUID(),
      environmentId: "local",
      name: validated.name?.trim() ?? (basename(rootPath) || rootPath),
      rootPath,
      createdAt,
    };
    let registered = project;
    // 在 Catalog 的更新锁内检查路径，保证并发注册返回同一个项目。
    yield* catalog.update((state) => {
      const existing = state.projects.find((candidate) => candidate.rootPath === rootPath);
      if (existing) {
        registered = existing;
        return state;
      }
      return {
        ...state,
        projects: [...state.projects, project],
        workspaces: [
          ...state.workspaces,
          {
            id: randomUUID(),
            projectId: project.id,
            cwd: rootPath,
            kind: "project-root",
            createdAt,
          },
        ],
      };
    });
    return registered;
  });

  const list = Effect.fn("ProjectService.list")(function* (): Effect.fn.Return<
    ReadonlyArray<ProjectMetadata>
  > {
    return (yield* catalog.read).projects;
  });

  const get = Effect.fn("ProjectService.get")(function* (
    projectId: string,
  ): Effect.fn.Return<ProjectMetadata, ProjectError> {
    const project = (yield* catalog.read).projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return yield* new ProjectError({
        reason: "NotFound",
        projectId,
        message: `Project ${projectId} is not registered.`,
      });
    }
    return project;
  });

  return ProjectService.of({ register, list, get });
}
