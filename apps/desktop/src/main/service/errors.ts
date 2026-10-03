import { Effect, Schema } from "effect";

export class DesktopServiceError extends Schema.TaggedError<DesktopServiceError>()(
  "DesktopServiceError",
  {
    code: Schema.Literals([
      "InvalidInput",
      "NotFound",
      "StorageUnavailable",
      "StorageCorrupt",
      "WorkspaceUnavailable",
      "ModelUnavailable",
      "Busy",
      "RuntimeClosing",
      "RecoveryRequired",
    ]),
    message: Schema.String,
  },
) {}

/** Keep adapter errors in the error channel, without exposing credentials or raw file contents. */
export function adapter<A>(
  message: string,
  run: () => Promise<A>,
  code: DesktopServiceError["code"] = "StorageUnavailable",
) {
  return Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof DesktopServiceError ? error : new DesktopServiceError({ code, message }),
  });
}
