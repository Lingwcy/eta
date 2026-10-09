import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@eta/agent";
import { openNodeJsonlStorage } from "@eta/agent/storage/jsonl/node";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { AppPathsService } from "../../platform/app-paths.ts";
import { adapter, CoreError } from "../errors.ts";
import { readJson, writeJson } from "../json-file.ts";
import type { EtaSessionMetadata } from "../../shared/sessions.ts";

const IdentitySchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
});

export class SessionRepositoryService extends Context.Service<
  SessionRepositoryService,
  {
    create(cwd: string): Effect.Effect<EtaSessionMetadata, CoreError>;
    open(ref: EtaSessionMetadata, initializing?: boolean): Effect.Effect<Storage, CoreError>;
    stageRemoval(ref: EtaSessionMetadata): Effect.Effect<
      {
        commit: Effect.Effect<void, CoreError>;
        rollback: Effect.Effect<void, CoreError>;
      },
      CoreError
    >;
    quarantine(ref: EtaSessionMetadata): Effect.Effect<void, CoreError>;
  }
>()("eta/core/service/sessions/SessionRepositoryService") {
  static readonly layer = Layer.effect(
    SessionRepositoryService,
    Effect.gen(function* () {
      const { sessionsRoot } = yield* AppPathsService;
      const checkedPath = (ref: EtaSessionMetadata) => {
        const { id, path, storageVersion } = ref.metadata;
        if (
          storageVersion !== 1 ||
          id !== relative(sessionsRoot, path) ||
          resolve(path) !== join(sessionsRoot, id) ||
          id.includes("/") ||
          id.includes("\\") ||
          id === "." ||
          id === ".."
        )
          throw new CoreError({
            code: "StorageCorrupt",
            message: "会话路径或存储版本无效；旧版 JSONL 不能直接当作 1.0 存储打开",
          });
        return path;
      };
      const verify = async (ref: EtaSessionMetadata) => {
        const path = checkedPath(ref);
        // Do not follow a substituted session symlink outside this installation's storage root.
        if ((await realpath(path)) !== join(await realpath(sessionsRoot), ref.metadata.id))
          throw new CoreError({
            code: "StorageCorrupt",
            message: "会话目录被替换，拒绝访问",
          });
        const raw = await readJson(join(path, "identity.json"));
        const identity = await Effect.runPromise(
          Schema.decodeUnknownEffect(IdentitySchema)(raw).pipe(
            Effect.mapError(
              () => new CoreError({ code: "StorageCorrupt", message: "会话身份文件无效" }),
            ),
          ),
        );
        if (identity.id !== ref.metadata.id || identity.cwd !== ref.metadata.cwd)
          throw new CoreError({
            code: "StorageCorrupt",
            message: "会话身份与 Catalog 不一致",
          });
        return path;
      };
      return SessionRepositoryService.of({
        create: Effect.fn("SessionRepositoryService.create")(function* (cwd: string) {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const id = randomUUID();
          const path = join(sessionsRoot, id);
          yield* adapter("无法创建会话目录", async () => {
            await mkdir(sessionsRoot, { recursive: true });
            await mkdir(path);
            await writeJson(join(path, "identity.json"), { version: 1, id, cwd });
          });
          return {
            backendId: "eta",
            metadata: { id, cwd, path, storageVersion: 1, createdAt: now, modifiedAt: now },
          };
        }),
        open: (ref, initializing = false) =>
          adapter(
            "会话存储损坏或不可读取；其他会话不受影响",
            async () => {
              const path = await verify(ref);
              if (!initializing && !(await stat(join(path, "main.jsonl"))).isFile())
                throw new Error("Missing transcript");
              return openNodeJsonlStorage(path, BACKGROUND_CONTEXT, { fsync: true });
            },
            "StorageCorrupt",
          ),
        stageRemoval: (ref) =>
          adapter("无法准备删除会话", async () => {
            const path = checkedPath(ref);
            const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return undefined;
            });
            if (!exists) return { commit: Effect.void, rollback: Effect.void };
            const trash = join(sessionsRoot, ".trash");
            await mkdir(trash, { recursive: true });
            const staged = join(trash, `${ref.metadata.id}-${randomUUID()}`);
            await rename(path, staged);
            return {
              commit: adapter("无法永久删除会话文件", () => rm(staged, { recursive: true })),
              rollback: adapter("无法恢复会话目录", () => rename(staged, path)),
            };
          }),
        // Recovery-friendly removal: neither a failed Catalog write nor deletion destroys the JSONL files.
        quarantine: (ref) =>
          adapter("无法移除会话存储", async () => {
            const path = await verify(ref);
            const trash = join(sessionsRoot, ".trash");
            await mkdir(trash, { recursive: true });
            await rename(path, join(trash, `${ref.metadata.id}-${randomUUID()}`));
          }),
      });
    }),
  );
}
