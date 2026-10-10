import { BotConnectionSchema } from "./bot-schema.ts";
import { SubagentCommandSchema, SubagentSettingsSchema } from "@eta/core/shared/subagent-schema";
import { builtinToolNames } from "@eta/core/tools";
import { agentThinkingVariants } from "../appearance.ts";
import { Schema } from "effect";
import type { DesktopApplication } from "./bootstrap.ts";
import type { CommandReply } from "../bridge.ts";
import { CoreError } from "@eta/core/service/errors";
import { ProjectError } from "@eta/core/service/projects/index";
import { CatalogStorageError } from "@eta/core/service/catalog/json-store";
import { CatalogValidationError } from "@eta/core/service/catalog/schema";
import { TitleModelSchema } from "@eta/core/shared/runtime-settings";
import { SandboxModeSchema } from "@eta/core/shared/sandbox";

const Id = Schema.NonEmptyString;
const Method = Schema.Literals(["oauth", "api_key"]);
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("bot-import-credentials") }),
  Schema.Struct({ type: Schema.Literal("bot-remove-credential"), providerId: Id }),
  Schema.Struct({ type: Schema.Literal("bot-connect"), connection: BotConnectionSchema }),
  Schema.Struct({ type: Schema.Literal("bot-disconnect") }),
  Schema.Struct({ type: Schema.Literal("bot-reconnect") }),
  Schema.Struct({
    type: Schema.Literal("subagent"),
    id: Id,
    requestId: Id,
    command: SubagentCommandSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("skills"),
    cwd: Schema.optional(Id),
    workspaceId: Schema.optional(Id),
  }),
  Schema.Struct({
    type: Schema.Literal("open-skills-directory"),
    path: Id,
    cwd: Schema.optional(Id),
  }),
  Schema.Struct({ type: Schema.Literal("unload-skill"), id: Id, name: Id }),
  Schema.Struct({ type: Schema.Literal("storage") }),
  Schema.Struct({
    type: Schema.Literal("reveal-storage"),
    target: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("sessions") }),
      Schema.Struct({ kind: Schema.Literals(["configuration", "session"]), id: Id }),
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("library") }),
  Schema.Struct({ type: Schema.Literal("create-cloud-project"), name: Id, requestId: Id }),
  Schema.Struct({ type: Schema.Literal("register-project"), rootPath: Id, name: Id }),
  Schema.Struct({
    type: Schema.Literal("create"),
    workspaceId: Id,
    requestId: Id,
    configuration: Schema.optional(
      Schema.Struct({
        provider: Id,
        modelId: Id,
        sandboxMode: Schema.optionalKey(SandboxModeSchema),
        thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
      }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("open"), id: Id }),
  Schema.Struct({ type: Schema.Literal("configure-sandbox"), id: Id, mode: SandboxModeSchema }),
  Schema.Struct({
    type: Schema.Literal("decide-approval"),
    id: Id,
    requestId: Id,
    approved: Schema.Boolean,
  }),
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
    sandboxMode: Schema.optionalKey(SandboxModeSchema),
    thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }),
  Schema.Struct({
    type: Schema.Literal("settings"),
    patch: Schema.Struct({
      defaultSandboxMode: Schema.optionalKey(SandboxModeSchema),
      subagents: Schema.optionalKey(SubagentSettingsSchema),
      defaultProvider: Schema.optionalKey(Id),
      defaultModel: Schema.optionalKey(Id),
      titleModel: Schema.optionalKey(TitleModelSchema),
      defaultThinkingLevel: Schema.optionalKey(
        Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
      ),
      activeThreadId: Schema.optionalKey(Id),
      disabledTools: Schema.optionalKey(Schema.Array(Schema.Literals(builtinToolNames))),
      skillsEnabled: Schema.optionalKey(Schema.Boolean),
      skillDirectories: Schema.optionalKey(Schema.Array(Id)),
      disabledSkills: Schema.optionalKey(Schema.Array(Id)),
      blockImages: Schema.optionalKey(Schema.Boolean),
      agentThinkingVariant: Schema.optionalKey(Schema.Literals(agentThinkingVariants)),
      autoCheckUpdates: Schema.optionalKey(Schema.Boolean),
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
    throw new CoreError({ code: "InvalidInput", message: "请求参数无效" });
  }
  switch (command.type) {
    case "bot-import-credentials":
      return application.importBotCredentials();
    case "bot-remove-credential":
      return application.removeBotCredential(command.providerId);
    case "bot-connect":
      return application.connectBot(command.connection);
    case "bot-disconnect":
      return application.disconnectBot();
    case "bot-reconnect":
      return application.reconnectBot();
    case "subagent":
      return application.subagent(command.id, command.command, command.requestId);
    case "skills":
      return application.skills(command.cwd, command.workspaceId);
    case "open-skills-directory":
      return application.openSkillsDirectory(command.path, command.cwd);
    case "unload-skill":
      return application.unloadSkill(command.id, command.name);
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
    case "create-cloud-project":
      return application.createCloudProject(command.name, command.requestId);
    case "register-project":
      return application.registerProject(command.rootPath, command.name);
    case "create":
      return application.createThread(
        command.workspaceId,
        command.requestId,
        command.configuration,
      );
    case "open":
      return application.openThread(command.id);
    case "configure-sandbox":
      return application.configureSandbox(command.id, command.mode);
    case "decide-approval":
      return application.decideApproval(command.id, command.requestId, command.approved);
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
      error instanceof CoreError
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
          "SandboxUnavailable",
          "StorageUnavailable",
          "RuntimeClosing",
        ].includes(code),
      },
    };
  }
}
