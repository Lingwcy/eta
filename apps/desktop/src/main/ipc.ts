import { builtinToolNames } from "../tools.ts";
import { Schema } from "effect";
import type { DesktopApplication } from "./bootstrap.ts";
import type { CommandReply } from "../bridge.ts";
import { DesktopServiceError } from "./service/errors.ts";
import { ProjectError } from "./service/projects/index.ts";
import { CatalogStorageError } from "./service/catalog/json-store.ts";
import { CatalogValidationError } from "./service/catalog/schema.ts";
import { TitleModelSchema } from "./service/settings/index.ts";

const Id = Schema.NonEmptyString;
const Method = Schema.Literals(["oauth", "api_key"]);
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("storage") }),
  Schema.Struct({
    type: Schema.Literal("reveal-storage"),
    target: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("sessions") }),
      Schema.Struct({ kind: Schema.Literals(["configuration", "session"]), id: Id }),
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("library") }),
  Schema.Struct({ type: Schema.Literal("register-project"), rootPath: Id, name: Id }),
  Schema.Struct({ type: Schema.Literal("create"), workspaceId: Id, requestId: Id }),
  Schema.Struct({ type: Schema.Literal("open"), id: Id }),
  Schema.Struct({ type: Schema.Literal("move-thread"), id: Id, projectId: Schema.NullOr(Id) }),
  Schema.Struct({ type: Schema.Literal("delete-thread"), id: Id }),
  Schema.Struct({ type: Schema.Literal("rename"), id: Id, title: Id }),
  Schema.Struct({ type: Schema.Literal("archive"), id: Id, archived: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("submit"),
    id: Id,
    prompt: Schema.String,
    requestId: Id,
    images: Schema.optional(
      Schema.Array(
        Schema.Struct({
          type: Schema.Literal("image"),
          data: Id,
          mimeType: Id,
          name: Schema.optional(Id),
          note: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("prepare-image"),
    source: Schema.Union([Schema.Struct({ path: Id }), Schema.Struct({ data: Id, name: Id })]),
    cwd: Schema.optional(Id),
    provider: Schema.optional(Id),
    modelId: Schema.optional(Id),
  }),
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
      titleModel: Schema.optionalKey(TitleModelSchema),
      defaultThinkingLevel: Schema.optionalKey(
        Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
      ),
      activeThreadId: Schema.optionalKey(Id),
      disabledTools: Schema.optionalKey(Schema.Array(Schema.Literals(builtinToolNames))),
      blockImages: Schema.optionalKey(Schema.Boolean),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("login-start"), provider: Id, method: Method }),
  Schema.Struct({ type: Schema.Literal("login-state"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("login-answer"),
    id: Id,
    promptId: Id,
    value: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("login-cancel"), id: Id }),
  Schema.Struct({ type: Schema.Literal("login-open"), id: Id, url: Id }),
  Schema.Struct({ type: Schema.Literal("logout"), provider: Id, method: Method }),
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
    case "storage":
      return application.storage();
    case "reveal-storage":
      return application.revealStorage(command.target);
    case "prepare-image":
      return application.prepareImage(
        command.source,
        command.cwd,
        command.provider,
        command.modelId,
      );
    case "library":
      return application.library();
    case "register-project":
      return application.registerProject(command.rootPath, command.name);
    case "create":
      return application.createThread(command.workspaceId, command.requestId);
    case "open":
      return application.openThread(command.id);
    case "move-thread":
      return application.moveThread(command.id, command.projectId);
    case "delete-thread":
      return application.deleteThread(command.id);
    case "rename":
      return application.renameThread(command.id, command.title);
    case "archive":
      return application.archiveThread(command.id, command.archived);
    case "submit":
      return application.submit(command.id, command.prompt, command.requestId, command.images);
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
    case "login-start":
      return application.startLogin(command.provider, command.method);
    case "login-state":
      return application.loginState(command.id);
    case "login-answer":
      return application.answerLogin(command.id, command.promptId, command.value);
    case "login-cancel":
      return application.cancelLogin(command.id);
    case "login-open":
      return application.openLoginLink(command.id, command.url);
    case "logout":
      return application.removeCredential(command.provider, command.method);
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
