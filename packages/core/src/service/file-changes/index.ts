import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId } from "@eta/agent";
import type { FileChangeCapture, FileChangeRecorder, FileChangeReference } from "@eta/agent/tools";
import { Context, Effect, Layer, Schema } from "effect";
import { AppPathsService } from "../../platform/app-paths.ts";
import type { DiffContent, FileChangeDiffInput } from "../../shared/diff.ts";
import type { EtaSessionMetadata } from "../../shared/sessions.ts";
import { CatalogService } from "../catalog/index.ts";
import { adapter, CoreError } from "../errors.ts";
import { readJson, writeJson } from "../json-file.ts";
import { SessionRepositoryService } from "../sessions/index.ts";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_RECORDS = 2_000;
const ReadySchema = Schema.Struct({
  status: Schema.Literal("ready"),
  path: Schema.String,
  patch: Schema.String,
});
const UnavailableSchema = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: Schema.Literals(["binary", "too-large", "symlink", "not-recorded"]),
});
const ArtifactSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  sessionId: Schema.String,
  taskId: Schema.String,
  conversationId: Schema.String,
  callId: Schema.String,
  path: Schema.String,
  state: Schema.Literals(["uncertain", "recorded", "no-change", "unavailable", "too-large"]),
  content: Schema.Union([ReadySchema, UnavailableSchema]),
});
const IdentitySchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  cwd: Schema.String,
});

/** Keep artifacts beneath the verified session so deletion/rollback shares the session's lifetime. */
async function sessionPath(ref: EtaSessionMetadata, sessionsRoot: string) {
  const { id, path, cwd, storageVersion } = ref.metadata;
  if (
    storageVersion !== 1 ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    relative(sessionsRoot, path) !== id ||
    resolve(path) !== join(sessionsRoot, id) ||
    (await realpath(path)) !== join(await realpath(sessionsRoot), id)
  )
    throw new CoreError({ code: "StorageCorrupt", message: "文件修改记录的会话身份无效" });
  const identity = Schema.decodeUnknownSync(IdentitySchema)(
    await readJson(join(path, "identity.json")),
  );
  if (identity.id !== id || identity.cwd !== cwd)
    throw new CoreError({ code: "StorageCorrupt", message: "文件修改记录的会话身份不匹配" });
  return path;
}

async function artifactDirectory(path: string, create = false) {
  const directory = join(path, "file-changes");
  if (create) await mkdir(directory, { recursive: true });
  try {
    if (
      !(await lstat(directory)).isDirectory() ||
      (await realpath(directory)) !== join(await realpath(path), "file-changes")
    )
      throw new CoreError({ code: "StorageCorrupt", message: "文件修改记录目录无效" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  return directory;
}

async function readArtifact(path: string) {
  let file;
  try {
    // Reject a FIFO through fstat without first waiting for a writer to open it.
    file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES)
      throw new CoreError({ code: "StorageCorrupt", message: "文件修改记录大小或类型无效" });
    // The file can grow after fstat; bound the read itself, not only its earlier size.
    const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_ARTIFACT_BYTES)
      throw new CoreError({ code: "StorageCorrupt", message: "文件修改记录大小或类型无效" });
    return Schema.decodeUnknownSync(ArtifactSchema)(
      JSON.parse(buffer.subarray(0, length).toString("utf8")),
    );
  } finally {
    await file.close();
  }
}

export class FileChangeService extends Context.Service<
  FileChangeService,
  {
    recorder(ref: EtaSessionMetadata): FileChangeRecorder;
    release(ref: EtaSessionMetadata): Promise<void>;
    fileChangeDiff(input: FileChangeDiffInput): Effect.Effect<DiffContent, CoreError>;
  }
>()("eta/core/service/file-changes/FileChangeService") {
  static readonly layer = Layer.effect(
    FileChangeService,
    Effect.gen(function* () {
      const catalog = yield* CatalogService;
      const paths = yield* AppPathsService;
      const repository = yield* SessionRepositoryService;
      const recorders = new Map<
        string,
        { recorder: FileChangeRecorder; stop: () => void; drain: () => Promise<void> }
      >();
      const releaseEntry = async (
        key: string,
        entry: { stop: () => void; drain: () => Promise<void> },
      ) => {
        entry.stop();
        await entry.drain();
        if (recorders.get(key) === entry) recorders.delete(key);
      };
      const release = async (ref: EtaSessionMetadata) => {
        const key = ref.metadata.path;
        const entry = recorders.get(key);
        if (entry) await releaseEntry(key, entry);
      };
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all([...recorders].map(([key, entry]) => releaseEntry(key, entry)));
        }),
      );
      const recorder = (ref: EtaSessionMetadata): FileChangeRecorder => {
        const key = ref.metadata.path;
        const existing = recorders.get(key);
        if (existing) return existing.recorder;
        let accepting = true;
        let pending = Promise.resolve();
        let quota: { bytes: number; count: number } | undefined;
        const serialized = <T>(run: () => Promise<T>) => {
          const result = pending.then(run);
          pending = result.then(
            () => {},
            () => {},
          );
          return result;
        };
        const record: FileChangeRecorder = async (candidate, path, api) => {
          const id = createHash("sha256").update(`${ref.metadata.id}\0${api.taskId}`).digest("hex");
          const reference: FileChangeReference = { id, path, status: "uncertain" };
          const unavailable = { ...reference, status: "unavailable" as const };
          const unavailableCapture = {
            reference: unavailable,
            applied: async () => unavailable,
          };
          if (!accepting) return unavailableCapture;
          try {
            return await serialized(async (): Promise<FileChangeCapture> => {
              if (!accepting) return unavailableCapture;
              const session = await sessionPath(ref, paths.sessionsRoot);
              const directory = (await artifactDirectory(session, true))!;
              const file = join(directory, `${id}.json`);
              // A recovered tool must never overwrite evidence of its earlier attempt.
              const previous = await readArtifact(file);
              if (previous)
                return {
                  reference: { id, path: previous.path, status: previous.state },
                  applied: async () => ({ id, path: previous.path, status: previous.state }),
                };
              if (!quota) {
                const names = (await readdir(directory)).filter((name) =>
                  /^[a-f0-9]{64}\.json$/.test(name),
                );
                const sizes = await Promise.all(
                  names.map(async (name) => (await stat(join(directory, name))).size),
                );
                quota = { count: names.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
              }
              const content =
                candidate.status === "ready"
                  ? { status: "ready" as const, path, patch: candidate.patch }
                  : candidate;
              const finalState: FileChangeReference["status"] =
                candidate.status === "ready"
                  ? candidate.noChange
                    ? "no-change"
                    : "recorded"
                  : candidate.reason === "too-large"
                    ? "too-large"
                    : "unavailable";
              const artifact = {
                version: 1 as const,
                id,
                sessionId: ref.metadata.id,
                taskId: String(api.taskId),
                conversationId: String(api.conversationId),
                callId: api.callId,
                path,
                state: "uncertain" as const,
                content,
              };
              const bytes = Buffer.byteLength(JSON.stringify(artifact));
              if (
                bytes > MAX_ARTIFACT_BYTES ||
                quota.count >= MAX_SESSION_RECORDS ||
                quota.bytes + bytes > MAX_SESSION_BYTES
              ) {
                const limited = { id: `limit-${id}`, path, status: "too-large" as const };
                return { reference: limited, applied: async () => limited };
              }
              await writeJson(file, artifact);
              quota.bytes += bytes;
              quota.count++;
              return {
                reference,
                applied: () => {
                  if (!accepting) return Promise.resolve(reference);
                  return serialized(async () => {
                    if (!accepting) return reference;
                    // Session deletion first drains producers; do not mkdir a deleted session during completion.
                    if ((await sessionPath(ref, paths.sessionsRoot)) !== session) return reference;
                    await writeJson(file, { ...artifact, state: finalState });
                    return { ...reference, status: finalState };
                  }).catch(() => reference);
                },
              };
            });
          } catch {
            // Preserve the write tool's behavior even when history storage is unavailable.
            const unavailable = { ...reference, status: "unavailable" as const };
            return { reference: unavailable, applied: async () => unavailable };
          }
        };
        recorders.set(key, {
          recorder: record,
          stop: () => {
            accepting = false;
          },
          drain: () => pending,
        });
        return record;
      };
      return FileChangeService.of({
        recorder,
        release,
        fileChangeDiff: Effect.fn("FileChangeService.fileChangeDiff")(function* (
          input: FileChangeDiffInput,
        ) {
          const state = yield* catalog.read;
          const thread = state.threads.find((thread) => thread.id === input.threadId);
          if (!thread) return yield* new CoreError({ code: "NotFound", message: "会话不存在" });
          if (input.changeId === "not-recorded")
            return { status: "unavailable", reason: "not-recorded" } as const;
          if (/^limit-[a-f0-9]{64}$/.test(input.changeId))
            return { status: "unavailable", reason: "too-large" } as const;
          const legacy = /^legacy:([1-9]\d*):(\d+)$/.exec(input.changeId);
          if (legacy) {
            const storage = yield* repository.open(thread.sessionRef);
            return yield* adapter("无法读取历史文件修改", async (): Promise<DiffContent> => {
              try {
                const record = await storage.entry(
                  Number(legacy[1]) as EntryId,
                  BACKGROUND_CONTEXT,
                );
                const message = record?.entry.model?.[Number(legacy[2])];
                if (
                  message?.role !== "toolResult" ||
                  message.toolName !== "edit" ||
                  message.isError
                )
                  return { status: "unavailable", reason: "not-recorded" };
                const details = Schema.decodeUnknownSync(Schema.Struct({ patch: Schema.String }))(
                  message.details,
                );
                if (Buffer.byteLength(details.patch) > MAX_ARTIFACT_BYTES)
                  return { status: "unavailable", reason: "too-large" };
                return { status: "ready", path: "", patch: details.patch };
              } finally {
                await storage.close(BACKGROUND_CONTEXT);
              }
            });
          }
          if (!/^[a-f0-9]{64}$/.test(input.changeId))
            return yield* new CoreError({ code: "InvalidInput", message: "文件修改标识无效" });
          return yield* adapter("无法读取历史文件修改", async (): Promise<DiffContent> => {
            const session = await sessionPath(thread.sessionRef, paths.sessionsRoot);
            const directory = await artifactDirectory(session);
            const artifact = directory
              ? await readArtifact(join(directory, `${input.changeId}.json`))
              : undefined;
            if (!artifact) return { status: "unavailable", reason: "not-recorded" };
            if (
              artifact.id !== input.changeId ||
              artifact.sessionId !== thread.sessionRef.metadata.id
            )
              throw new CoreError({ code: "StorageCorrupt", message: "文件修改记录身份无效" });
            if (artifact.state === "uncertain")
              return { status: "unavailable", reason: "uncertain" };
            return artifact.content;
          });
        }),
      });
    }),
  );
}
