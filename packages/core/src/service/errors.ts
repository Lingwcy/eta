import { Effect, Schema } from "effect";

export class CoreError extends Schema.TaggedError<CoreError>()("CoreError", {
  code: Schema.Literals([
    "InvalidInput",
    "NotFound",
    "StorageUnavailable",
    "StorageCorrupt",
    "WorkspaceUnavailable",
    "ModelUnavailable",
    "SandboxUnavailable",
    "Busy",
    "RuntimeClosing",
    "RecoveryRequired",
  ]),
  message: Schema.String,
}) {}

/** Keep adapter errors in the error channel, without exposing credentials or raw file contents. */
export function adapter<A>(
  message: string,
  run: () => Promise<A>,
  code: CoreError["code"] = "StorageUnavailable",
) {
  return Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof CoreError ? error : new CoreError({ code, message })),
  });
}
