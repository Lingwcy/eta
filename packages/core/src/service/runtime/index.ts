import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentsExtension, SubagentsDoc } from "../../agent/extension/subagent/index.ts";
import { RuntimeSettingsService } from "../settings/index.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, ROOT_CONVERSATION_ID } from "@eta/agent";
import type { AgentChange, Conversation, ConversationWatch, Registry, Storage } from "@eta/agent";
import type { ExecutionEnv } from "@eta/agent/env";
import { CoreEnvironmentService } from "../environment.ts";
import { Context, Effect, Layer } from "effect";
import { adapter, CoreError } from "../errors.ts";
import { ModelCatalogService } from "../models/index.ts";
import { AgentResourcesService } from "../resources/index.ts";
import { SessionRepositoryService } from "../sessions/index.ts";
import { normalizeThinkingLevel } from "../conversations/thinking.ts";
import type { EtaSessionMetadata } from "../../shared/sessions.ts";
import { ThreadTitleService } from "../titles/index.ts";
import { createRuntimeTools } from "./tools.ts";
import { recoverRuntime, hasForegroundWork } from "./recovery.ts";
import { createTitleTask, TitleDoc } from "../../agent/extension/title/task.ts";
import { SkillsService } from "../skills/index.ts";
import { SkillsDoc } from "../skills/extension.ts";
import { SandboxDoc } from "./sandbox.ts";
import { AppPathsService } from "../../platform/app-paths.ts";
import { defaultSandboxMode } from "../../shared/sandbox.ts";
import type { SandboxMode, SandboxStatus } from "../../shared/sandbox.ts";
import { sandboxStatus } from "../../platform/sandbox/backend.ts";
import { createSandboxApprovals, ApprovalsDoc } from "./approvals.ts";
import { SandboxedExecutionEnv } from "../../platform/sandbox/environment.ts";

export interface ThreadRuntime {
  readonly hasWork: () => Promise<boolean>;
  readonly subagents: ReturnType<typeof createSubagentsExtension>;
  readonly refreshTools: () => Promise<void>;
  readonly prepareSkills: (prompt: string) => Promise<void>;
  readonly harness: Harness;
  readonly registry: Registry;
  readonly storage: Storage;
  readonly conversation: Conversation;
  readonly titleTask: ReturnType<typeof createTitleTask>;
  readonly ref: EtaSessionMetadata;
  readonly watches: Set<ConversationWatch>;
  recoveryRequired: boolean;
  running: boolean;
  disposed: boolean;
  error?: string;
  blockedReason?: string;
  readonly changes: Set<() => void>;
  readonly sandbox: () => Promise<SandboxStatus>;
  readonly configureSandbox: (mode: SandboxMode) => Promise<void>;
  readonly approvals: ReturnType<typeof createSandboxApprovals>;
  readonly revokeSandboxGrants: () => Promise<void>;
}

export class RuntimeRegistryService extends Context.Service<
  RuntimeRegistryService,
  {
    acquire(
      ref: EtaSessionMetadata,
      initial?: AgentChange,
      sandboxMode?: SandboxMode,
    ): Effect.Effect<ThreadRuntime, CoreError>;
    peek(ref: EtaSessionMetadata): Effect.Effect<ThreadRuntime | undefined, CoreError>;
    close(ref: EtaSessionMetadata): Effect.Effect<void, CoreError>;
    readonly shutdown: Effect.Effect<void, CoreError>;
  }
>()("eta/core/service/runtime/RuntimeRegistryService") {
  static readonly layer = Layer.effect(
    RuntimeRegistryService,
    Effect.gen(function* () {
      const repository = yield* SessionRepositoryService;
      const { models } = yield* ModelCatalogService;
      const preferences = yield* RuntimeSettingsService;
      const skillsService = yield* SkillsService;
      const resources = yield* AgentResourcesService;
      const titles = yield* ThreadTitleService;
      const environment = yield* CoreEnvironmentService;
      const paths = yield* AppPathsService;
      const opening = new Map<string, Promise<ThreadRuntime>>();
      const releasing = new Map<string, Promise<void>>();
      let closing = false;
      const key = (ref: EtaSessionMetadata) => ref.metadata.id;
      const open = async (
        ref: EtaSessionMetadata,
        initial?: AgentChange,
        requestedSandboxMode?: SandboxMode,
      ): Promise<ThreadRuntime> => {
        const storage = await Effect.runPromise(repository.open(ref, initial !== undefined));
        const scratchRoot = await mkdtemp(join(tmpdir(), "eta-thread-sandbox-"));
        const environments = new Set<ExecutionEnv>();
        const sandboxEnvironments = new Map<string, Promise<ExecutionEnv>>();
        let harness: Harness | undefined;
        let runtimeRecord: ThreadRuntime | undefined;
        try {
          const registry = resources.registry(models);
          const approvals = createSandboxApprovals(
            () => harness!,
            ref.metadata.cwd,
            async (taskId) => {
              const key = `tool:${taskId}`;
              const pending = sandboxEnvironments.get(key);
              sandboxEnvironments.delete(key);
              if (pending) {
                const env = await pending;
                await env.cleanup(BACKGROUND_CONTEXT);
                environments.delete(env);
              }
            },
            [paths.dataRoot],
          );
          registry.install(approvals.extension);
          const initialSandboxMode = initial
            ? (requestedSandboxMode ??
              (await Effect.runPromise(preferences.read)).defaultSandboxMode ??
              defaultSandboxMode)
            : defaultSandboxMode;
          if (initial && !environment.allowedSandboxModes.includes(initialSandboxMode))
            throw new CoreError({ code: "InvalidInput", message: "此执行环境不允许所选沙盒模式" });
          const titleTask = createTitleTask(
            async () => Boolean((await Effect.runPromise(preferences.read)).blockImages),
            resources.processImage,
          );
          registry.install({ name: "desktop-thread-title", tasks: [titleTask] });
          const subagents = createSubagentsExtension({
            invalid: (message) => {
              throw new CoreError({ code: "InvalidInput", message });
            },
            harness: () => harness!,
            ready: () => runtimeRecord !== undefined && !runtimeRecord.recoveryRequired,
            settings: async () => (await Effect.runPromise(preferences.read)).subagents,
            available: async (provider, modelId) =>
              (await models.getAvailable(provider)).some((model) => model.id === modelId),
            clamp: (ref, level) => {
              const model = models.getModel(ref.provider, ref.modelId);
              if (!model) throw new Error("模型不可用");
              return clampThinkingLevel(model, level);
            },
            maximumImages: (ref) =>
              models.getModel(ref.provider, ref.modelId)?.inputLimits?.images?.maxPerMessage,
            instructions: () => Effect.runPromise(resources.instructions(ref.metadata.cwd)),
          });
          registry.install(subagents.extension);
          const tools = createRuntimeTools({
            registry,
            harness: () => harness,
            subagents,
            readSettings: () => Effect.runPromise(preferences.read),
            skillCatalog: () => Effect.runPromise(skillsService.catalog(ref.metadata.cwd)),
          });
          const refreshTools = tools.refresh;
          await refreshTools();
          for (const extension of await environment.extensions(ref, models))
            registry.install(extension);
          harness = await Harness.open(
            storage,
            {
              models,
              settings: {
                stream: {
                  headers: {
                    // Keep routing and prompt caching stable across requests and desktop restarts.
                    "x-opencode-session": ref.metadata.id,
                    "User-Agent": environment.userAgent,
                  },
                },
              },
              registry,
              conversationCreated: async (tx, conversation) => {
                const sandbox = await tx.doc(SandboxDoc);
                await tx.doc(ApprovalsDoc);
                if (conversation.id === ROOT_CONVERSATION_ID && initial)
                  sandbox.mode = initialSandboxMode;
                await tx.doc(SubagentsDoc);
                await tx.doc(TitleDoc, conversation.id);
                await tx.doc(SkillsDoc, conversation.id);
              },
              env: async ({ cwd, read, taskId, taskKind }, context) => {
                const state = await read.snapshot(SandboxDoc, context);
                const mode = state?.mode ?? defaultSandboxMode;
                if (!environment.allowedSandboxModes.includes(mode))
                  throw new Error("此执行环境不允许当前沙盒模式，请选择允许的模式");
                const requests = await read.snapshot(ApprovalsDoc, context);
                const grant = requests?.requests.findLast(
                  (request) =>
                    request.toolTaskId === String(taskId) &&
                    request.status === "approved" &&
                    request.revision === state?.revision,
                );
                const key =
                  taskKind === "pi.tool"
                    ? `tool:${taskId}`
                    : `${mode}:${state?.revision ?? 0}:${cwd ?? ref.metadata.cwd}`;
                let opening = sandboxEnvironments.get(key);
                if (!opening) {
                  opening = Promise.resolve(
                    environment.executionEnvironment(cwd ?? ref.metadata.cwd, {
                      mode,
                      workspaceRoot: ref.metadata.cwd,
                      deniedRoots: [paths.dataRoot],
                      scratchRoot,
                      ...(grant
                        ? {
                            commandAccess: grant.tool === "bash",
                            readableRoots: grant.readableRoots,
                            writableRoots: grant.writableRoots,
                            networkAccess: mode === "workspace-write" || grant.networkAccess,
                          }
                        : {}),
                    }),
                  ).then((env) => {
                    environments.add(env);
                    if (taskKind === "pi.tool") {
                      const abort = () => {
                        void env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
                      };
                      if (context.abortSignal?.aborted) abort();
                      else context.abortSignal?.addEventListener("abort", abort, { once: true });
                    }
                    return env;
                  });
                  sandboxEnvironments.set(key, opening);
                  void opening.catch(() => sandboxEnvironments.delete(key));
                }
                return opening;
              },
            },
            BACKGROUND_CONTEXT,
          );
          const conversation = initial
            ? await harness.root(BACKGROUND_CONTEXT, { agent: initial })
            : await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
          if (!conversation)
            throw new CoreError({
              code: "StorageCorrupt",
              message: "持久会话缺少根 conversation",
            });
          const { inspection, recoveryRequired } = await recoverRuntime(harness, subagents);
          // Idle history can contain levels saved before the picker respected model capabilities.
          // Pending work retains its pinned request configuration until it is resumed or stopped.
          if (!recoveryRequired) await normalizeThinkingLevel(conversation, models);
          const record: ThreadRuntime = {
            harness,
            registry,
            approvals,
            subagents,
            hasWork: async () => {
              const inspection = await harness!.inspect(BACKGROUND_CONTEXT);
              return hasForegroundWork(inspection);
            },
            refreshTools,
            prepareSkills: (prompt) => tools.prepareSkills(conversation, prompt),
            conversation,
            titleTask,
            storage,
            ref,
            watches: new Set(),
            changes: new Set(),
            sandbox: async () => {
              const state = await harness!.snapshot(SandboxDoc, BACKGROUND_CONTEXT);
              const mode = state?.mode ?? defaultSandboxMode;
              if (!environment.allowedSandboxModes.includes(mode))
                return {
                  mode,
                  backend: "unavailable",
                  available: false,
                  reason: "此执行环境不允许当前沙盒模式",
                  allowedModes: environment.allowedSandboxModes,
                };
              const status = await sandboxStatus({ mode, workspaceRoot: ref.metadata.cwd });
              const key = `${mode}:${state?.revision ?? 0}:${ref.metadata.cwd}`;
              try {
                let pending = sandboxEnvironments.get(key);
                if (!pending) {
                  pending = Promise.resolve(
                    environment.executionEnvironment(ref.metadata.cwd, {
                      mode,
                      workspaceRoot: ref.metadata.cwd,
                      deniedRoots: [paths.dataRoot],
                      scratchRoot,
                    }),
                  ).then((env) => {
                    environments.add(env);
                    return env;
                  });
                  sandboxEnvironments.set(key, pending);
                  void pending.catch(() => sandboxEnvironments.delete(key));
                }
                const env = await pending;
                return {
                  ...(env instanceof SandboxedExecutionEnv ? env.status : status),
                  allowedModes: environment.allowedSandboxModes,
                };
              } catch (error) {
                return {
                  ...status,
                  available: false,
                  allowedModes: environment.allowedSandboxModes,
                  reason: error instanceof Error ? error.message : "沙盒执行环境无法启动",
                };
              }
            },
            configureSandbox: async (mode) => {
              if (!environment.allowedSandboxModes.includes(mode))
                throw new CoreError({
                  code: "InvalidInput",
                  message: "此执行环境不允许所选沙盒模式",
                });
              const state = await harness!.snapshot(SandboxDoc, BACKGROUND_CONTEXT);
              if (state?.mode === mode) return;
              if (record.running || record.recoveryRequired || (await record.hasWork()))
                throw new CoreError({
                  code: "Busy",
                  message: "请先停止线程及子智能体，再切换沙盒模式",
                });
              await Promise.all([...environments].map((env) => env.cleanup(BACKGROUND_CONTEXT)));
              environments.clear();
              sandboxEnvironments.clear();
              await conversation.commit(async (tx) => {
                const sandbox = await tx.doc(SandboxDoc);
                sandbox.mode = mode;
                sandbox.revision++;
              }, BACKGROUND_CONTEXT);
              for (const notify of record.changes) notify();
            },
            revokeSandboxGrants: async () => {
              await conversation.commit(async (tx) => {
                const sandbox = await tx.doc(SandboxDoc);
                sandbox.revision++;
                const approvals = await tx.doc(ApprovalsDoc);
                for (const request of approvals.requests)
                  if (request.status === "pending" || request.status === "approved")
                    request.status = "cancelled";
              }, BACKGROUND_CONTEXT);
              await Promise.all([...environments].map((env) => env.cleanup(BACKGROUND_CONTEXT)));
              environments.clear();
              sandboxEnvironments.clear();
            },
            recoveryRequired,
            running: false,
            disposed: false,
          };
          // Older sessions acquire the application document when first opened after this upgrade.
          runtimeRecord = record;
          await conversation.commit(async (tx) => {
            await tx.doc(SubagentsDoc);
            await tx.doc(TitleDoc, conversation.id);
            await tx.doc(SkillsDoc, conversation.id);
            await tx.doc(SandboxDoc);
            await tx.doc(ApprovalsDoc);
          }, BACKGROUND_CONTEXT);
          await approvals.invalidate(conversation.id);
          if (!recoveryRequired) await subagents.wake();
          await refreshTools();
          let settingsDelivery = Promise.resolve();
          const unsubscribeSettings = preferences.subscribe(() => {
            settingsDelivery = settingsDelivery
              .then(async () => {
                if (record.disposed) return;
                await refreshTools();
                await conversation.commit(async (tx) => {
                  const doc = await tx.doc(SubagentsDoc);
                  doc.revision = (doc.revision ?? 0) + 1;
                }, BACKGROUND_CONTEXT);
              })
              .catch((error: unknown) => {
                if (!record.disposed) {
                  record.error = error instanceof Error ? error.message : "无法应用设置";
                  for (const notify of record.changes) notify();
                }
              });
          });
          const subagentWatch = await harness.watchDoc(SubagentsDoc, BACKGROUND_CONTEXT);
          subagentWatch?.start(async () => {
            for (const notify of record.changes) notify();
          });
          const approvalWatch = await harness.watchDoc(ApprovalsDoc, BACKGROUND_CONTEXT);
          approvalWatch?.start(async () => {
            for (const notify of record.changes) notify();
          });
          const stopTitle = await Effect.runPromise(titles.watch(record));
          cleanups.set(record, async () => {
            record.disposed = true;
            unsubscribeSettings();
            await settingsDelivery;
            await subagentWatch?.stop();
            await approvalWatch?.stop();
            await stopTitle();
            await Promise.all([...record.watches].map((watch) => watch.stop()));
            record.watches.clear();
            record.changes.clear();
            try {
              // Keep background delegates recoverable while preserving the root's normal stop-on-close behavior.
              if (record.running && environment.shutdown === "abortForeground")
                await conversation.abort(BACKGROUND_CONTEXT);
            } finally {
              try {
                await harness!.close(BACKGROUND_CONTEXT);
              } finally {
                await Promise.all([...environments].map((env) => env.cleanup(BACKGROUND_CONTEXT)));
                await rm(scratchRoot, { recursive: true, force: true });
              }
            }
          });
          // Only the title task may resume silently; foreground work still requires explicit recovery.
          if (!recoveryRequired && inspection.tasks.length) harness.resume();
          return record;
        } catch (error) {
          if (harness) await harness.close(BACKGROUND_CONTEXT);
          else await storage.close(BACKGROUND_CONTEXT);
          await Promise.all([...environments].map((env) => env.cleanup(BACKGROUND_CONTEXT)));
          await rm(scratchRoot, { recursive: true, force: true });
          throw error;
        }
      };
      const cleanups = new WeakMap<ThreadRuntime, () => Promise<void>>();
      const closeOne = (ref: EtaSessionMetadata): Promise<void> => {
        const existing = releasing.get(key(ref));
        if (existing) return existing;
        const pending = opening.get(key(ref));
        if (!pending) return Promise.resolve();
        const release = pending.then(async (record) => {
          await cleanups.get(record)?.();
          opening.delete(key(ref));
        });
        releasing.set(key(ref), release);
        void release
          .finally(() => {
            releasing.delete(key(ref));
          })
          .catch(() => {});
        return release;
      };
      const shutdown = adapter("运行资源关闭失败", async () => {
        closing = true;
        const records = await Promise.allSettled(opening.values());
        const closed = await Promise.allSettled(
          records.flatMap((result) =>
            result.status === "fulfilled" ? [closeOne(result.value.ref)] : [],
          ),
        );
        const failure = closed.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
      yield* Effect.addFinalizer(() =>
        shutdown.pipe(Effect.catch((error) => Effect.logError(error.message))),
      );
      return RuntimeRegistryService.of({
        acquire: (ref, initial, sandboxMode) =>
          adapter("无法打开持久会话", () => {
            if (closing) throw new CoreError({ code: "RuntimeClosing", message: "服务正在关闭" });
            if (releasing.has(key(ref)))
              throw new CoreError({
                code: "RuntimeClosing",
                message: "会话正在释放运行资源",
              });
            let pending = opening.get(key(ref));
            if (!pending) {
              pending = open(ref, initial, sandboxMode);
              opening.set(key(ref), pending);
              void pending.catch(() => {
                if (opening.get(key(ref)) === pending) opening.delete(key(ref));
              });
            }
            return pending.then((record) => {
              if (
                record.ref.metadata.cwd !== ref.metadata.cwd ||
                record.ref.metadata.path !== ref.metadata.path ||
                record.ref.metadata.storageVersion !== ref.metadata.storageVersion
              )
                throw new CoreError({
                  code: "StorageCorrupt",
                  message: "同一会话身份被绑定到不同存储位置",
                });
              return record;
            });
          }).pipe(Effect.uninterruptible),
        peek: (ref) => adapter("无法读取运行资源状态", async () => opening.get(key(ref))),
        close: (ref) =>
          adapter("无法关闭会话运行资源", () => closeOne(ref)).pipe(Effect.uninterruptible),
        shutdown,
      });
    }),
  );
}
