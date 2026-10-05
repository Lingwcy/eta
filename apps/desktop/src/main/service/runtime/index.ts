import { omitImages } from "../../../images/content.ts";
import { DesktopSettingsService } from "../settings/index.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, ROOT_CONVERSATION_ID, GenerationTask, hook } from "@eta/agent";
import type { AgentChange, Conversation, ConversationWatch, Storage } from "@eta/agent";
import { NodeExecutionEnv } from "@eta/agent/env/node";
import { Context, Effect, Layer } from "effect";
import { adapter, DesktopServiceError } from "../errors.ts";
import { ModelCatalogService } from "../models/index.ts";
import { AgentResourcesService } from "../resources/index.ts";
import { SessionRepositoryService } from "../sessions/index.ts";
import { normalizeThinkingLevel } from "../conversations/thinking.ts";
import type { EtaSessionMetadata } from "../sessions/type.ts";
import { DesktopCatalogService } from "../catalog/index.ts";
import { createTitleTask, TitleDoc, TITLE_TASK_KIND } from "../threads/title.ts";

export interface ThreadRuntime {
  readonly refreshTools: () => Promise<void>;
  readonly harness: Harness;
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
    ): Effect.Effect<ThreadRuntime, DesktopServiceError>;
    peek(ref: EtaSessionMetadata): Effect.Effect<ThreadRuntime | undefined, DesktopServiceError>;
    close(ref: EtaSessionMetadata): Effect.Effect<void, DesktopServiceError>;
    readonly shutdown: Effect.Effect<void, DesktopServiceError>;
  }
>()("eta/desktop/main/service/runtime/RuntimeRegistryService") {
  static readonly layer = Layer.effect(
    RuntimeRegistryService,
    Effect.gen(function* () {
      const repository = yield* SessionRepositoryService;
      const { models } = yield* ModelCatalogService;
      const preferences = yield* DesktopSettingsService;
      const resources = yield* AgentResourcesService;
      const catalog = yield* DesktopCatalogService;
      const opening = new Map<string, Promise<ThreadRuntime>>();
      const releasing = new Map<string, Promise<void>>();
      let closing = false;
      const key = (ref: EtaSessionMetadata) => ref.metadata.id;
      const open = async (
        ref: EtaSessionMetadata,
        initial?: AgentChange,
      ): Promise<ThreadRuntime> => {
        const storage = await Effect.runPromise(repository.open(ref, initial !== undefined));
        const environments = new Set<NodeExecutionEnv>();
        let harness: Harness | undefined;
        try {
          const registry = resources.registry(models);
          const titleTask = createTitleTask(
            async () => Boolean((await Effect.runPromise(preferences.read)).blockImages),
            resources.processImage,
          );
          registry.install({ name: "desktop-thread-title", tasks: [titleTask] });
          const codingTools = registry.snapshot().extension("coding-tools")!;
          const refreshTools = async () => {
            const disabled = new Set<string>(
              (await Effect.runPromise(preferences.read)).disabledTools ?? [],
            );
            registry.install({
              ...codingTools,
              tools: codingTools.tools?.filter((tool) => !disabled.has(tool.name)),
            });
          };
          await refreshTools();
          registry.install({
            name: "desktop-image-settings",
            hooks: [
              hook(GenerationTask, {
                beforeRequest: async ({ messages }) =>
                  (await Effect.runPromise(preferences.read)).blockImages
                    ? { messages: omitImages(messages) }
                    : undefined,
              }),
            ],
          });
          harness = await Harness.open(
            storage,
            {
              models,
              settings: {
                stream: {
                  headers: {
                    // Keep routing and prompt caching stable across requests and desktop restarts.
                    "x-opencode-session": ref.metadata.id,
                    "User-Agent": "eta-desktop",
                  },
                },
              },
              registry,
              conversationCreated: async (tx, conversation) => {
                await tx.doc(TitleDoc, conversation.id);
              },
              env: ({ cwd }) => {
                const env = new NodeExecutionEnv({ cwd: cwd ?? ref.metadata.cwd });
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
            throw new DesktopServiceError({
              code: "StorageCorrupt",
              message: "持久会话缺少根 conversation",
            });
          const inspection = await harness.inspect(BACKGROUND_CONTEXT);
          const recoveryRequired =
            inspection.submissions.length > 0 ||
            inspection.tasks.some(
              ({ record }) => record.kind !== TITLE_TASK_KIND || !record.background,
            );
          // Idle history can contain levels saved before the picker respected model capabilities.
          // Pending work retains its pinned request configuration until it is resumed or stopped.
          if (!recoveryRequired) await normalizeThinkingLevel(conversation, models);
          const record: ThreadRuntime = {
            harness,
            refreshTools,
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
          await conversation.commit(async (tx) => {
            await tx.doc(TitleDoc, conversation.id);
          }, BACKGROUND_CONTEXT);
          const titleWatch = await harness.watchDoc(TitleDoc, conversation.id, BACKGROUND_CONTEXT);
          let titleDelivery = Promise.resolve();
          const publishTitle = (value: NonNullable<typeof titleWatch>["value"]) => {
            titleDelivery = Effect.runPromise(
              Effect.gen(function* () {
                const title = value?.title;
                if (!title || record.disposed) return;
                const current = (yield* catalog.read).threads.find(
                  (thread) => thread.sessionRef.metadata.id === ref.metadata.id,
                );
                if (current?.titleSource !== "temporary") return;
                yield* catalog.update((state) => ({
                  ...state,
                  threads: state.threads.map((thread) =>
                    thread.id === current.id && thread.titleSource === "temporary"
                      ? { ...thread, title, titleSource: "generated" as const }
                      : thread,
                  ),
                }));
              }).pipe(Effect.catch((error) => Effect.logError(error.message))),
            );
            return titleDelivery;
          };
          if (titleWatch) {
            await publishTitle(titleWatch.value);
            titleWatch.start(publishTitle);
          }
          cleanups.set(record, async () => {
            record.disposed = true;
            await titleWatch?.stop();
            await titleDelivery;
            await Promise.all([...record.watches].map((watch) => watch.stop()));
            record.watches.clear();
            record.changes.clear();
            try {
              if (record.running)
                await conversation.abort(BACKGROUND_CONTEXT, { background: true });
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
            if (closing)
              throw new DesktopServiceError({ code: "RuntimeClosing", message: "服务正在关闭" });
            if (releasing.has(key(ref)))
              throw new DesktopServiceError({
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
                throw new DesktopServiceError({
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
