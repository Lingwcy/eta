import { Schema } from "effect";
import type { DesktopApplication } from "./bootstrap.ts";
import type { CommandReply } from "../bridge.ts";
import { DesktopServiceError } from "./service/errors.ts";
import { ProjectError } from "./service/projects/index.ts";
import { CatalogStorageError } from "./service/catalog/json-store.ts";
import { CatalogValidationError } from "./service/catalog/schema.ts";

const Id = Schema.NonEmptyString;
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("library") }),
  Schema.Struct({ type: Schema.Literal("register-project"), rootPath: Id, name: Id }),
  Schema.Struct({ type: Schema.Literal("create"), workspaceId: Id, requestId: Id }),
  Schema.Struct({ type: Schema.Literal("open"), id: Id }),
  Schema.Struct({ type: Schema.Literal("rename"), id: Id, title: Id }),
  Schema.Struct({ type: Schema.Literal("archive"), id: Id, archived: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("submit"), id: Id, prompt: Id, requestId: Id }),
  Schema.Struct({ type: Schema.Literal("stop"), id: Id }),
  Schema.Struct({ type: Schema.Literal("resume"), id: Id }),
  Schema.Struct({ type: Schema.Literal("compact"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("configure"),
    id: Id,
    provider: Id,
    modelId: Id,
    thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }),
  Schema.Struct({
    type: Schema.Literal("settings"),
    patch: Schema.Struct({
      defaultProvider: Schema.optionalKey(Id),
      defaultModel: Schema.optionalKey(Id),
      defaultThinkingLevel: Schema.optionalKey(
        Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
      ),
      activeThreadId: Schema.optionalKey(Id),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("credential"), provider: Id, key: Id }),
  Schema.Struct({ type: Schema.Literal("logout"), provider: Id }),
]);
const decode = Schema.decodeUnknownSync(Command, { onExcessProperty: "error" });

/** Validate unknown renderer payloads once, before any filesystem or runtime operation. */
export async function dispatchCommand(application: DesktopApplication, raw: unknown) {
  let command: typeof Command.Type;
  try {
    command = decode(raw);
  } catch {
    throw new DesktopServiceError({ code: "InvalidInput", message: "请求参数无效" });
  }
  switch (command.type) {
    case "library":
      return application.library();
    case "register-project":
      return application.registerProject(command.rootPath, command.name);
    case "create":
      return application.createThread(command.workspaceId, command.requestId);
    case "open":
      return application.openThread(command.id);
    case "rename":
      return application.renameThread(command.id, command.title);
    case "archive":
      return application.archiveThread(command.id, command.archived);
    case "submit":
      return application.submit(command.id, command.prompt, command.requestId);
    case "stop":
      return application.stop(command.id);
    case "resume":
      return application.resume(command.id);
    case "compact":
      return application.compact(command.id);
    case "configure":
      return application.configureThread(
        command.id,
        command.provider,
        command.modelId,
        command.thinkingLevel,
      );
    case "settings":
      return application.updateSettings(command.patch);
    case "credential":
      return application.setApiKey(command.provider, command.key);
    case "logout":
      return application.removeCredential(command.provider);
  }
}

export async function commandReply<A>(action: () => Promise<A>): Promise<CommandReply<A>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const code =
      error instanceof DesktopServiceError
        ? error.code
        : error instanceof ProjectError
          ? error.reason
          : error instanceof CatalogStorageError
            ? "StorageUnavailable"
            : error instanceof CatalogValidationError
              ? "StorageCorrupt"
              : "InternalError";
    return {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : "操作失败",
        retryable: [
          "Busy",
          "ModelUnavailable",
          "WorkspaceUnavailable",
          "StorageUnavailable",
          "RuntimeClosing",
        ].includes(code),
      },
    };
  }
}
