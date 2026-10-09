import { clampThinkingLevel } from "@earendil-works/pi-ai";
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
}

export class RuntimeRegistryService extends Context.Service<
  RuntimeRegistryService,
  {
    acquire(
      ref: EtaSessionMetadata,
      initial?: AgentChange,
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
      const opening = new Map<string, Promise<ThreadRuntime>>();
      const releasing = new Map<string, Promise<void>>();
      let closing = false;
      const key = (ref: EtaSessionMetadata) => ref.metadata.id;
      const open = async (
        ref: EtaSessionMetadata,
        initial?: AgentChange,
      ): Promise<ThreadRuntime> => {
        const storage = await Effect.runPromise(repository.open(ref, initial !== undefined));
        const environments = new Set<ExecutionEnv>();
        let harness: Harness | undefined;
        let runtimeRecord: ThreadRuntime | undefined;
        try {
          const registry = resources.registry(models);
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
                await tx.doc(SubagentsDoc);
                await tx.doc(TitleDoc, conversation.id);
                await tx.doc(SkillsDoc, conversation.id);
              },
              env: async ({ cwd }) => {
                const env = await environment.executionEnvironment(cwd ?? ref.metadata.cwd);
                environments.add(env);
                return env;
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
          }, BACKGROUND_CONTEXT);
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
          const stopTitle = await Effect.runPromise(titles.watch(record));
          cleanups.set(record, async () => {
            record.disposed = true;
            unsubscribeSettings();
            await settingsDelivery;
            await subagentWatch?.stop();
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
        acquire: (ref, initial) =>
          adapter("无法打开持久会话", () => {
            if (closing) throw new CoreError({ code: "RuntimeClosing", message: "服务正在关闭" });
            if (releasing.has(key(ref)))
              throw new CoreError({
                code: "RuntimeClosing",
                message: "会话正在释放运行资源",
              });
            let pending = opening.get(key(ref));
            if (!pending) {
              pending = open(ref, initial);
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
