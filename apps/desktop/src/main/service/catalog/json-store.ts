import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { AppPathsService } from "../../platform/app-paths.ts";
import { CatalogValidationError, encodeCatalog, parseCatalog } from "./schema.ts";
import type { CatalogState } from "./type.ts";

export class CatalogStorageError extends Schema.TaggedError<CatalogStorageError>()(
  "CatalogStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    path: Schema.String,
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

export type CatalogError = CatalogValidationError | CatalogStorageError;

export class CatalogStoreService extends Context.Service<
  CatalogStoreService,
  {
    readonly load: Effect.Effect<CatalogState, CatalogError>;
    save(state: CatalogState): Effect.Effect<void, CatalogError>;
  }
>()("eta/desktop/main/service/catalog/CatalogStoreService") {
  static readonly layer = Layer.effect(
    CatalogStoreService,
    Effect.gen(function* () {
      const paths = yield* AppPathsService;
      return make(paths.catalogPath);
    }),
  );
}

const isMissing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

function make(path: string) {
  /**
   * 读取并返回类名结构
   */
  const load: Effect.Effect<CatalogState, CatalogError> = Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(path, "utf8");
        } catch (cause) {
          if (isMissing(cause)) return undefined;
          throw cause;
        }
      },
      catch: (cause) =>
        new CatalogStorageError({
          operation: "read",
          path,
          cause,
          message: `Failed to read catalog ${path}.`,
        }),
    });
    if (text === undefined) return { projects: [], workspaces: [], threads: [] };
    return yield* parseCatalog(text);
  });
  /**
   * 保存内存类目到磁盘
   */
  const save = Effect.fn("CatalogStoreService.save")(function* (state: CatalogState) {
    const text = yield* encodeCatalog(state);
    // Node 文件写入不能通过 fiber 中断停止，必须等实际写入结束。
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        try {
          // 同目录临时文件保证 rename 在同一文件系统内原子替换。
          await writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
          await rename(temporaryPath, path);
        } catch (cause) {
          try {
            await rm(temporaryPath, { force: true });
          } catch (cleanupCause) {
            throw new AggregateError([cause, cleanupCause], `Failed to clean up ${temporaryPath}.`);
          }
          throw cause;
        }
      },
      catch: (cause) =>
        new CatalogStorageError({
          operation: "write",
          path,
          cause,
          message: `Failed to write catalog ${path}.`,
        }),
    }).pipe(Effect.uninterruptible);
  });

  return CatalogStoreService.of({ load, save });
}
