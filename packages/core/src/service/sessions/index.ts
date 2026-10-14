import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, stat, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@eta/agent";
import { openNodeJsonlStorage } from "@eta/agent/storage/jsonl/node";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { CatalogService } from "../catalog/index.ts";
import { AppPathsService } from "../../platform/app-paths.ts";
import { adapter, CoreError } from "../errors.ts";
import { readJson, writeJson } from "../json-file.ts";
import type { EtaSessionMetadata } from "../../shared/sessions.ts";

const IdentitySchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
});

const RemovalSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
  staged: Schema.NonEmptyString,
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
      const catalog = yield* CatalogService;
      const trash = join(sessionsRoot, ".trash");
      const exists = async (path: string) =>
        lstat(path)
          .then(() => true)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          });
      // The rename and Catalog replacement cannot be one filesystem transaction. Journal first;
      // recover before opening any thread, keeping old unjournaled quarantine files untouched.
      const current = yield* catalog.read;
      yield* adapter("无法恢复未完成的会话删除", async () => {
        const files = await readdir(trash).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const file of files.filter((name) => name.endsWith(".removal.json"))) {
          const journal = join(trash, file);
          const removal = Schema.decodeUnknownSync(RemovalSchema, { onExcessProperty: "error" })(
            await readJson(journal),
          );
          if (
            basename(removal.sessionId) !== removal.sessionId ||
            removal.sessionId === "." ||
            removal.sessionId === ".." ||
            removal.sessionId.includes("\\") ||
            basename(removal.staged) !== removal.staged ||
            removal.staged.includes("\\") ||
            !removal.staged.startsWith(`${removal.sessionId}-`) ||
            file !== `${removal.staged}.removal.json`
          )
            throw new CoreError({ code: "StorageCorrupt", message: "会话删除日志标识无效" });
          const path = join(sessionsRoot, removal.sessionId);
          const staged = join(trash, removal.staged);
          const referenced = current.threads.some(
            (thread) => thread.sessionRef.metadata.id === removal.sessionId,
          );
          if (referenced) {
            const [originalExists, stagedExists] = await Promise.all([
              exists(path),
              exists(staged),
            ]);
            if (stagedExists && !originalExists) await rename(staged, path);
            else if (stagedExists || !originalExists)
              throw new CoreError({
                code: "StorageCorrupt",
                message: "会话删除暂存状态冲突，保留文件待检查",
              });
          } else await rm(staged, { recursive: true, force: true });
          await rm(journal);
        }
      });
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
            const present = await lstat(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return undefined;
            });
            if (!present) return { commit: Effect.void, rollback: Effect.void };
            await mkdir(trash, { recursive: true });
            const stagedName = `${ref.metadata.id}-${randomUUID()}`;
            const staged = join(trash, stagedName);
            const journal = join(trash, `${stagedName}.removal.json`);
            await writeJson(journal, {
              version: 1,
              sessionId: ref.metadata.id,
              staged: stagedName,
            });
            await rename(path, staged);
            return {
              commit: adapter("无法永久删除会话文件", async () => {
                await rm(staged, { recursive: true });
                await rm(journal);
              }),
              rollback: adapter("无法恢复会话目录", async () => {
                await rename(staged, path);
                await rm(journal);
              }),
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
