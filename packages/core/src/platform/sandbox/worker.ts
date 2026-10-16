import { NodeExecutionEnv } from "@eta/agent/env/node";
import { getOrThrow } from "@eta/agent/env";
import type { BinaryReader, DirReader, FileWatcher, TextLineReader } from "@eta/agent/env";
import { Schema } from "effect";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { RequestSchema } from "./protocol.ts";
import type { WorkerMessage, WorkerRequest } from "./protocol.ts";

const env = new NodeExecutionEnv({ cwd: process.cwd(), detachedCommands: false });
const readers = new Map<number, TextLineReader>();
const binaryReaders = new Map<number, BinaryReader>();
const dirReaders = new Map<number, DirReader>();
const watchers = new Map<number, FileWatcher>();
const invocations = new Map<number, AbortController>();
let readerSequence = 0;
const send = (message: WorkerMessage) => process.send?.(message);
const requiredPath = (request: WorkerRequest) => {
  if (request.path === undefined) throw new Error("Missing path");
  return request.path;
};

async function execute(request: WorkerRequest, signal: AbortSignal): Promise<unknown> {
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const path = () => requiredPath(request);
  const content = () =>
    request.binary ? Buffer.from(request.content ?? "", "base64") : (request.content ?? "");
  switch (request.method) {
    case "absolutePath":
      return getOrThrow(await env.absolutePath(path(), context));
    case "joinPath":
      return getOrThrow(await env.joinPath([...(request.parts ?? [])], context));
    case "readTextFile":
      return getOrThrow(await env.readTextFile(path(), context));
    case "openTextLineReader": {
      const reader = getOrThrow(await env.openTextLineReader(path(), context));
      const id = ++readerSequence;
      readers.set(id, reader);
      return id;
    }
    case "readLine": {
      const reader = readers.get(request.reader!);
      if (!reader) throw new Error("Reader is closed");
      return getOrThrow(await reader.readLine(context));
    }
    case "closeReader": {
      await readers.get(request.reader!)?.close(context);
      readers.delete(request.reader!);
      await binaryReaders.get(request.reader!)?.close(context);
      binaryReaders.delete(request.reader!);
      await dirReaders.get(request.reader!)?.close(context);
      dirReaders.delete(request.reader!);
      return;
    }
    case "openBinaryReader": {
      const reader = getOrThrow(await env.openBinaryReader(path(), request.options, context));
      const id = ++readerSequence;
      binaryReaders.set(id, reader);
      return id;
    }
    case "binaryInfo":
      return getOrThrow(await binaryReaders.get(request.reader!)!.info(context));
    case "binaryRead":
      return Buffer.from(
        getOrThrow(
          await binaryReaders.get(request.reader!)!.read(request.offset!, request.length!, context),
        ),
      ).toString("base64");
    case "scanLines":
      return getOrThrow(
        await binaryReaders
          .get(request.reader!)!
          .scanLines(
            { startLine: request.options!.startLine!, endLine: request.options?.endLine },
            context,
          ),
      );
    case "openDirReader": {
      const reader = getOrThrow(await env.openDirReader(path(), context));
      const id = ++readerSequence;
      dirReaders.set(id, reader);
      return id;
    }
    case "readDir":
      return getOrThrow(
        await dirReaders.get(request.reader!)!.next(request.options!.maxEntries!, context),
      );
    case "watch": {
      const watcher = getOrThrow(
        await env.watch(
          request.targets!,
          (change) =>
            send({
              id: request.id,
              event: "watch",
              change:
                "error" in change
                  ? {
                      error: {
                        code: change.error.code,
                        message: change.error.message,
                        ...(change.error.path ? { path: change.error.path } : {}),
                      },
                    }
                  : change,
            }),
          context,
        ),
      );
      watchers.set(request.id, watcher);
      return { id: request.id, mode: watcher.mode };
    }
    case "closeWatcher":
      await watchers.get(request.reader!)?.close(context);
      watchers.delete(request.reader!);
      return;
    case "readTextLines":
      return getOrThrow(await env.readTextLines(path(), request.options, context));
    case "readBinaryFile":
      return Buffer.from(getOrThrow(await env.readBinaryFile(path(), context))).toString("base64");
    case "writeFile":
      return getOrThrow(await env.writeFile(path(), content(), context));
    case "appendFile":
      return getOrThrow(await env.appendFile(path(), content(), context));
    case "truncateFile":
      return getOrThrow(await env.truncateFile(path(), request.size!, context));
    case "flushFile":
      return getOrThrow(await env.flushFile(path(), context));
    case "renameFile":
      return getOrThrow(await env.renameFile(path(), request.destination!, context));
    case "fileInfo":
      return getOrThrow(await env.fileInfo(path(), context));
    case "listDir":
      return getOrThrow(await env.listDir(path(), context));
    case "canonicalPath":
      return getOrThrow(await env.canonicalPath(path(), context));
    case "exists":
      return getOrThrow(await env.exists(path(), context));
    case "createDir":
      return getOrThrow(await env.createDir(path(), request.options, context));
    case "remove":
      return getOrThrow(await env.remove(path(), request.options, context));
    case "createTempDir":
      return getOrThrow(await env.createTempDir(request.options?.prefix, context));
    case "createTempFile":
      return getOrThrow(await env.createTempFile(request.options, context));
    case "exec":
      return getOrThrow(
        await env.exec(
          request.command ?? path(),
          {
            ...request.options,
            inheritEnv: false,
            // Child commands receive no IPC channel or worker-specific process configuration.
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: process.env.HOME ?? "",
              TMPDIR: process.env.TMPDIR ?? "",
              ...(process.env.GIT_CONFIG_NOSYSTEM
                ? { GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
                : {}),
              ...request.options?.env,
            },
            onOutput: (value, _context, outputInfo) =>
              send({ id: request.id, event: "output", value, outputInfo }),
          },
          context,
        ),
      );
    case "cleanup": {
      await env.cleanup(context);
      for (const reader of readers.values()) await reader.close(context);
      readers.clear();
      for (const reader of binaryReaders.values()) await reader.close(context);
      binaryReaders.clear();
      for (const reader of dirReaders.values()) await reader.close(context);
      dirReaders.clear();
      for (const watcher of watchers.values()) await watcher.close(context);
      watchers.clear();
      return;
    }
    case "cancel":
      invocations.get(request.id)?.abort();
      return;
  }
}

process.on("message", (value) => {
  const request = Schema.decodeUnknownSync(RequestSchema)(value);
  if (request.method === "cancel") {
    invocations.get(request.id)?.abort();
    return;
  }
  const controller = new AbortController();
  invocations.set(request.id, controller);
  void execute(request, controller.signal)
    .then(
      (result) =>
        send({
          id: request.id,
          event: "result",
          ...(result === undefined ? {} : { value: result }),
        }),
      (error: unknown) =>
        send({
          id: request.id,
          event: "result",
          error: {
            code: error instanceof Error && "code" in error ? String(error.code) : "unknown",
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && "path" in error && typeof error.path === "string"
              ? { path: error.path }
              : {}),
            ...(error instanceof Error &&
            "spillPath" in error &&
            typeof error.spillPath === "string"
              ? { spillPath: error.spillPath }
              : {}),
          },
        }),
    )
    .finally(() => invocations.delete(request.id));
});
process.on("disconnect", () => {
  for (const controller of invocations.values()) controller.abort();
  void env.cleanup(BACKGROUND_CONTEXT).finally(() => process.exit());
});
send({ id: 0, event: "ready" });
