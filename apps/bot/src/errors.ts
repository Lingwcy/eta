import { CoreError } from "@eta/core";
import { ProjectError } from "@eta/core/service/projects/index";
import { CatalogStorageError } from "@eta/core/service/catalog/json-store";
import { CatalogValidationError } from "@eta/core/service/catalog/schema";

export class BotHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function httpError(error: unknown) {
  if (error instanceof BotHttpError) return error;
  if (error instanceof CoreError) {
    const status =
      error.code === "NotFound"
        ? 404
        : error.code === "InvalidInput"
          ? 400
          : ["Busy", "RecoveryRequired", "WorkspaceUnavailable", "SandboxUnavailable"].includes(
                error.code,
              )
            ? 409
            : 503;
    return new BotHttpError(status, error.code, error.message);
  }
  if (error instanceof ProjectError)
    return new BotHttpError(error.reason === "NotFound" ? 404 : 400, error.reason, error.message);
  if (error instanceof CatalogStorageError)
    return new BotHttpError(503, "StorageUnavailable", "Persistent storage is unavailable.");
  if (error instanceof CatalogValidationError)
    return new BotHttpError(503, "StorageCorrupt", "Persistent catalog is invalid.");
  return new BotHttpError(500, "InternalError", "The operation could not be completed.");
}
