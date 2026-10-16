import { Schema } from "effect";

export const RequestSchema = Schema.Struct({
  id: Schema.Int,
  method: Schema.Literals([
    "absolutePath",
    "joinPath",
    "readTextFile",
    "openTextLineReader",
    "readLine",
    "closeReader",
    "readTextLines",
    "readBinaryFile",
    "openBinaryReader",
    "binaryInfo",
    "binaryRead",
    "scanLines",
    "openDirReader",
    "readDir",
    "watch",
    "closeWatcher",
    "writeFile",
    "appendFile",
    "truncateFile",
    "flushFile",
    "renameFile",
    "fileInfo",
    "listDir",
    "canonicalPath",
    "exists",
    "createDir",
    "remove",
    "createTempDir",
    "createTempFile",
    "exec",
    "cleanup",
    "cancel",
  ]),
  path: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  targets: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        recursive: Schema.optionalKey(Schema.Boolean),
        exclude: Schema.optionalKey(
          Schema.Struct({
            hidden: Schema.optionalKey(Schema.Boolean),
            names: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      }),
    ),
  ),
  destination: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Schema.Array(Schema.String)),
  content: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.Boolean),
  size: Schema.optionalKey(Schema.Number),
  reader: Schema.optionalKey(Schema.Int),
  offset: Schema.optionalKey(Schema.Number),
  length: Schema.optionalKey(Schema.Number),
  options: Schema.optionalKey(
    Schema.Struct({
      noFollow: Schema.optionalKey(Schema.Boolean),
      maxEntries: Schema.optionalKey(Schema.Number),
      startLine: Schema.optionalKey(Schema.Number),
      endLine: Schema.optionalKey(Schema.Number),
      window: Schema.optionalKey(
        Schema.Struct({
          maxBytes: Schema.Number,
          maxLines: Schema.Number,
          minIntervalMs: Schema.Number,
          bytesPerSecond: Schema.Number,
        }),
      ),
      maxLines: Schema.optionalKey(Schema.Number),
      recursive: Schema.optionalKey(Schema.Boolean),
      force: Schema.optionalKey(Schema.Boolean),
      prefix: Schema.optionalKey(Schema.String),
      suffix: Schema.optionalKey(Schema.String),
      cwd: Schema.optionalKey(Schema.String),
      timeout: Schema.optionalKey(Schema.Number),
      env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      spill: Schema.optionalKey(
        Schema.Struct({ afterBytes: Schema.Number, afterLines: Schema.Number }),
      ),
    }),
  ),
});
export type WorkerRequest = typeof RequestSchema.Type;

export const MessageSchema = Schema.Struct({
  id: Schema.Int,
  event: Schema.Literals(["ready", "result", "output", "watch"]),
  change: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ paths: Schema.Array(Schema.String) }),
      Schema.Struct({ overflow: Schema.Literal(true) }),
      Schema.Struct({
        error: Schema.Struct({
          code: Schema.String,
          message: Schema.String,
          path: Schema.optionalKey(Schema.String),
        }),
      }),
    ]),
  ),
  outputInfo: Schema.optionalKey(
    Schema.Struct({
      stream: Schema.Literals(["stdout", "stderr"]),
      skipped: Schema.optionalKey(
        Schema.Struct({
          bytes: Schema.Number,
          newlines: Schema.Number,
          endsWithNewline: Schema.Boolean,
        }),
      ),
    }),
  ),
  value: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      path: Schema.optionalKey(Schema.String),
      spillPath: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type WorkerMessage = typeof MessageSchema.Type;
