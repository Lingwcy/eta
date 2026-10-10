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
  destination: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Schema.Array(Schema.String)),
  content: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.Boolean),
  size: Schema.optionalKey(Schema.Number),
  reader: Schema.optionalKey(Schema.Int),
  options: Schema.optionalKey(
    Schema.Struct({
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
  event: Schema.Literals(["ready", "result", "output"]),
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
