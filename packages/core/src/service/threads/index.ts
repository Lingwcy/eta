import { canGenerateTitle, applyInputTitle, applyManualTitle } from "../titles/policy.ts";
import type { SubagentCommand, SubagentSummary } from "../../shared/subagents.ts";
import type { CreateThreadConfiguration, SnapshotResponse } from "../../agent/protocol.ts";
import type { ThreadRuntime } from "../runtime/index.ts";
import type { ImageAttachment } from "../../images/types.ts";
import { randomUUID } from "node:crypto";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Context, DateTime, Effect, Layer, SynchronizedRef } from "effect";
import type { OperationAdmission, SessionResponse, ThinkingLevel } from "../../agent/protocol.ts";
import { CatalogService } from "../catalog/index.ts";
import type { CatalogError } from "../catalog/json-store.ts";
import { ConversationService } from "../conversations/index.ts";
import { adapter, CoreError } from "../errors.ts";
import { ModelCatalogService } from "../models/index.ts";
import { ObservationService } from "../observation/index.ts";
import { AgentResourcesService } from "../resources/index.ts";
import { RunSupervisorService } from "../runs/index.ts";
import { RuntimeRegistryService } from "../runtime/index.ts";
import { SessionRepositoryService } from "../sessions/index.ts";
import { RuntimeSettingsService } from "../settings/index.ts";
import { WorkspaceService } from "../workspaces/index.ts";
import type { ThreadMetadata } from "../../shared/threads.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTitle } from "./title.ts";
import { SkillsDoc } from "../skills/extension.ts";
import type { OperationResult, RecoveryState } from "../../agent/protocol.ts";
import { readOperation, readRecovery } from "./operations.ts";
import type { JsonValue } from "@earendil-works/chord";
import { enqueueTask, readTask } from "./tasks.ts";

export type ThreadError = CoreError | CatalogError;
export interface OpenThread extends SessionResponse {
  thread: ThreadMetadata;
}

export class ThreadService extends Context.Service<
  ThreadService,
  {
    subagent(
      id: string,
      command: SubagentCommand,
      requestId: string,
    ): Effect.Effect<readonly SubagentSummary[], ThreadError>;
    openSubagent(id: string, path: string): Effect.Effect<SnapshotResponse, ThreadError>;
    list(
      workspaceId?: string,
      includeArchived?: boolean,
    ): Effect.Effect<ReadonlyArray<ThreadMetadata>>;
    get(id: string): Effect.Effect<ThreadMetadata, CoreError>;
    create(
      workspaceId: string,
      requestId?: string,
      configuration?: CreateThreadConfiguration,
    ): Effect.Effect<OpenThread, ThreadError>;
    open(id: string): Effect.Effect<OpenThread, ThreadError>;
    operation(id: string, operationId: string): Effect.Effect<OperationResult, ThreadError>;
    operationByRequest(
      id: string,
      requestId: string,
    ): Effect.Effect<OperationResult | undefined, ThreadError>;
    recovery(id: string): Effect.Effect<RecoveryState, ThreadError>;
    enqueueTask(
      id: string,
      kind: string,
      input: JsonValue,
      requestId: string,
    ): Effect.Effect<Awaited<ReturnType<typeof enqueueTask>>, ThreadError>;
    task(
      id: string,
      taskId: string,
    ): Effect.Effect<Awaited<ReturnType<typeof readTask>>, ThreadError>;
    move(id: string, projectId: string | null): Effect.Effect<ThreadMetadata, ThreadError>;
    remove(id: string): Effect.Effect<void, ThreadError>;
    rename(id: string, title: string): Effect.Effect<ThreadMetadata, ThreadError>;
    archive(id: string, archived: boolean): Effect.Effect<ThreadMetadata, ThreadError>;
    submit(
      id: string,
      prompt: string,
      requestId?: string,
      images?: readonly ImageAttachment[],
    ): Effect.Effect<OperationAdmission, ThreadError>;
    stop(id: string): Effect.Effect<void, ThreadError>;
    resume(id: string): Effect.Effect<void, ThreadError>;
    compact(id: string): Effect.Effect<void, ThreadError>;
    unloadSkill(id: string, name: string): Effect.Effect<void, ThreadError>;
    configure(
      id: string,
      provider: string,
      modelId: string,
      thinkingLevel: ThinkingLevel,
    ): Effect.Effect<OpenThread, ThreadError>;
    subscribe(
      id: string,
      onSnapshot: Parameters<ObservationService["Service"]["subscribe"]>[1],
      onError: (message: string) => void,
      path?: string,
    ): Effect.Effect<() => void, ThreadError>;
  }
>()("eta/core/service/threads/ThreadService") {
  static readonly layer = Layer.effect(
    ThreadService,
    Effect.gen(function* () {
      const catalog = yield* CatalogService;
      const workspaces = yield* WorkspaceService;
      const repository = yield* SessionRepositoryService;
      const registry = yield* RuntimeRegistryService;
      const models = yield* ModelCatalogService;
      const settings = yield* RuntimeSettingsService;
      const resources = yield* AgentResourcesService;
      const conversations = yield* ConversationService;
      const observations = yield* ObservationService;
      const runs = yield* RunSupervisorService;
      const mutations = yield* SynchronizedRef.make(0);
      const locked = <A, E>(action: Effect.Effect<A, E>) =>
        SynchronizedRef.modifyEffect(mutations, () =>
          action.pipe(Effect.map((result) => [result, 0] as const)),
        ).pipe(Effect.uninterruptible);
      const get = Effect.fn("ThreadService.get")(function* (id: string) {
        const thread = (yield* catalog.read).threads.find((value) => value.id === id);
        if (!thread) return yield* new CoreError({ code: "NotFound", message: "会话不存在" });
        return thread;
      });
      const runtimeFor = Effect.fn("ThreadService.runtime")(function* (
        id: string,
        execution = false,
      ) {
        const thread = yield* get(id);
        if (execution && thread.archivedAt !== undefined)
          return yield* new CoreError({
            code: "InvalidInput",
            message: "归档会话需要先恢复，才能继续执行",
          });
        return yield* registry.acquire(thread.sessionRef);
      });
      const childRuntime = async (runtime: ThreadRuntime, path: string): Promise<ThreadRuntime> => {
        const child = (await runtime.subagents.list()).find((child) => child.path === path);
        if (!child) throw new CoreError({ code: "NotFound", message: "子智能体不存在" });
        const record = await runtime.storage.conversation(
          child.conversationId as typeof runtime.conversation.id,
          BACKGROUND_CONTEXT,
        );
        const conversation =
          record && (await runtime.harness.conversation(record.id, BACKGROUND_CONTEXT));
        if (!conversation) throw new CoreError({ code: "NotFound", message: "子智能体会话不存在" });
        return {
          ...runtime,
          conversation,
          error: undefined,
          get disposed() {
            return runtime.disposed;
          },
          get recoveryRequired() {
            return runtime.recoveryRequired;
          },
          get blockedReason() {
            return runtime.blockedReason;
          },
        };
      };
      const open = Effect.fn("ThreadService.open")(function* (id: string) {
        const thread = yield* get(id);
        const runtime = yield* registry.acquire(thread.sessionRef);
        const blocked = yield* runs.blockedReason(runtime);
        runtime.blockedReason =
          thread.archivedAt !== undefined ? "此会话已归档，请先恢复" : blocked;
        const observation = yield* observations.snapshot(runtime);
        return { id, thread, model: yield* conversations.model(runtime), ...observation };
      });
      const change = Effect.fn("ThreadService.change")(function* (
        id: string,
        transform: (thread: ThreadMetadata) => ThreadMetadata,
      ) {
        yield* get(id);
        const state = yield* catalog.update((state) => ({
          ...state,
          threads: state.threads.map((thread) => (thread.id === id ? transform(thread) : thread)),
        }));
        return state.threads.find((thread) => thread.id === id)!;
      });
      return ThreadService.of({
        subagent: (id, command, requestId) =>
          locked(
            Effect.gen(function* () {
              const runtime = yield* runtimeFor(id, command.action !== "list");
              if (
                runtime.recoveryRequired &&
                command.action !== "list" &&
                command.action !== "stop"
              )
                return yield* new CoreError({
                  code: "RecoveryRequired",
                  message: "请先恢复或停止未完成任务",
                });
              if (command.action === "spawn" || command.action === "send")
                yield* adapter("无法更新工具", runtime.refreshTools);
              yield* adapter("无法管理子智能体", async () => {
                const actor =
                  command.parent && command.parent !== "/root"
                    ? (await childRuntime(runtime, command.parent)).conversation.id
                    : runtime.conversation.id;
                await runtime.subagents.execute(command, actor, requestId);
                runtime.harness.resume();
              });
              return yield* adapter("无法读取子智能体", runtime.subagents.list);
            }),
          ),
        openSubagent: (id, path) =>
          Effect.gen(function* () {
            const runtime = yield* runtimeFor(id);
            const child = yield* adapter("无法打开子智能体", () => childRuntime(runtime, path));
            return yield* observations.snapshot(child);
          }),
        unloadSkill: (id, name) =>
          locked(
            Effect.gen(function* () {
              const runtime = yield* runtimeFor(id);
              if (
                runtime.running ||
                runtime.recoveryRequired ||
                (yield* adapter("无法检查任务", runtime.hasWork))
              )
                return yield* new CoreError({
                  code: "Busy",
                  message: "请先停止或完成当前任务，再移除技能",
                });
              yield* adapter("无法移除技能", () =>
                runtime.conversation.commit(async (tx) => {
                  const state = await tx.doc(SkillsDoc, runtime.conversation.id);
                  state.active = state.active.filter((skill) => skill.name !== name);
                }, BACKGROUND_CONTEXT),
              );
              for (const notify of runtime.changes) notify();
            }),
          ),
        get,
        list: (workspaceId, includeArchived = false) =>
          catalog.read.pipe(
            Effect.map((state) =>
              state.threads.filter(
                (thread) =>
                  (!workspaceId || thread.workspaceId === workspaceId) &&
                  (includeArchived || thread.archivedAt === undefined),
              ),
            ),
          ),
        open: (id) => locked(open(id)),
        operation: (id, operationId) =>
          Effect.gen(function* () {
            const runtime = yield* runtimeFor(id);
            return yield* adapter("无法读取执行记录", () => readOperation(runtime, operationId));
          }),
        operationByRequest: (id, requestId) =>
          Effect.gen(function* () {
            const runtime = yield* runtimeFor(id);
            return yield* adapter("无法读取请求记录", async () => {
              const receipt = await runtime.storage.submissionByRequest(
                runtime.conversation.id,
                requestId,
                BACKGROUND_CONTEXT,
              );
              return receipt?.type === "input"
                ? readOperation(runtime, String(receipt.id))
                : undefined;
            });
          }),
        recovery: (id) =>
          Effect.gen(function* () {
            const runtime = yield* runtimeFor(id);
            return yield* adapter("无法检查恢复状态", () => readRecovery(runtime));
          }),
        enqueueTask: (id, kind, input, requestId) =>
          locked(
            Effect.gen(function* () {
              const runtime = yield* runtimeFor(id, true);
              return yield* adapter("无法接收宿主任务", () =>
                enqueueTask(runtime, kind, input, requestId),
              );
            }),
          ),
        task: (id, taskId) =>
          Effect.gen(function* () {
            const runtime = yield* runtimeFor(id);
            return yield* adapter("无法读取宿主任务", () => readTask(runtime, taskId));
          }),
        create: (workspaceId, requestId, configuration) =>
          locked(
            Effect.gen(function* () {
              if (requestId) {
                const existing = (yield* catalog.read).threads.find(
                  (thread) => thread.requestId === requestId,
                );
                if (existing) {
                  if (existing.workspaceId !== workspaceId)
                    return yield* new CoreError({
                      code: "InvalidInput",
                      message: "此创建请求已经绑定到另一个工作区",
                    });
                  return yield* open(existing.id);
                }
              }
              const workspace = yield* workspaces.validate(workspaceId);
              const defaults = yield* settings.read;
              const model = yield* models.select(
                configuration
                  ? {
                      ...defaults,
                      defaultProvider: configuration.provider,
                      defaultModel: configuration.modelId,
                    }
                  : defaults,
              );
              const selected = models.models.getModel(model.provider, model.id);
              if (!selected)
                return yield* new CoreError({
                  code: "ModelUnavailable",
                  message: "模型不可用",
                });
              const thinkingLevel = clampThinkingLevel(
                selected,
                configuration?.thinkingLevel ?? defaults.defaultThinkingLevel,
              );
              const instructions = yield* resources.instructions(workspace.cwd);
              const ref = yield* repository.create(workspace.cwd);
              const thread: ThreadMetadata = {
                id: randomUUID(),
                workspaceId,
                sessionRef: ref,
                title: "新会话",
                titleSource: "temporary",
                createdAt: DateTime.toEpochMillis(yield* DateTime.now),
                ...(requestId ? { requestId } : {}),
              };
              yield* Effect.gen(function* () {
                yield* registry.acquire(ref, {
                  model: { provider: model.provider, modelId: model.id },
                  thinkingLevel: thinkingLevel === "off" ? null : thinkingLevel,
                  cwd: workspace.cwd,
                  instructions,
                });
                yield* catalog.update((state) => ({
                  ...state,
                  threads: [...state.threads, thread],
                }));
              }).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* registry
                      .close(ref)
                      .pipe(Effect.catch((cleanup) => Effect.logError(cleanup.message)));
                    yield* repository
                      .quarantine(ref)
                      .pipe(Effect.catch((cleanup) => Effect.logError(cleanup.message)));
                    return yield* Effect.fail(error);
                  }),
                ),
              );
              return yield* open(thread.id);
            }),
          ),
        move: (id, projectId) =>
          locked(
            Effect.gen(function* () {
              if (
                projectId !== null &&
                !(yield* catalog.read).projects.some((project) => project.id === projectId)
              )
                return yield* new CoreError({ code: "NotFound", message: "项目不存在" });
              return yield* change(id, (thread) => ({ ...thread, projectId }));
            }),
          ),
        remove: (id) =>
          locked(
            Effect.gen(function* () {
              const thread = yield* get(id);
              const runtime = yield* registry.peek(thread.sessionRef);
              if (
                runtime &&
                (runtime.running ||
                  runtime.recoveryRequired ||
                  (yield* adapter("无法检查任务", runtime.hasWork)))
              )
                return yield* new CoreError({
                  code: "Busy",
                  message: "请先停止未完成的任务，再删除会话",
                });
              yield* registry.close(thread.sessionRef);
              const removal = yield* repository.stageRemoval(thread.sessionRef);
              yield* catalog
                .update((state) => ({
                  ...state,
                  threads: state.threads.filter((thread) => thread.id !== id),
                }))
                .pipe(
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      yield* removal.rollback;
                      return yield* Effect.fail(error);
                    }),
                  ),
                );
              yield* removal.commit;
            }),
          ),
        rename: (id, title) =>
          !title.trim()
            ? Effect.fail(new CoreError({ code: "InvalidInput", message: "标题不能为空" }))
            : locked(change(id, (thread) => applyManualTitle(thread, title))),
        archive: (id, archived) =>
          locked(
            Effect.gen(function* () {
              const existing = yield* get(id);
              const runtime = yield* registry.peek(existing.sessionRef);
              if (
                archived &&
                runtime &&
                (runtime.running ||
                  runtime.recoveryRequired ||
                  (yield* adapter("无法检查任务", runtime.hasWork)))
              )
                return yield* new CoreError({
                  code: "Busy",
                  message: "请先停止未完成的任务，再归档",
                });
              const now = DateTime.toEpochMillis(yield* DateTime.now);
              const thread = yield* change(id, (thread) => {
                const { archivedAt: _archivedAt, ...rest } = thread;
                return archived ? { ...rest, archivedAt: now } : rest;
              });
              if (runtime) {
                runtime.blockedReason = archived
                  ? "此会话已归档，请先恢复"
                  : yield* runs.blockedReason(runtime);
                for (const notify of runtime.changes) notify();
              }
              return thread;
            }),
          ),
        submit: (id, prompt, requestId, images) =>
          locked(
            Effect.gen(function* () {
              const runtime = yield* runtimeFor(id, true);
              const current = yield* get(id);
              const automatic = canGenerateTitle(current);
              const titleModel = automatic
                ? ((yield* settings.read).titleModel ??
                  (yield* Effect.promise(() => runtime.conversation.agent(BACKGROUND_CONTEXT)))
                    .model)
                : undefined;
              const admission = yield* runs.submit(runtime, prompt, requestId, images);
              yield* change(id, (thread) => ({
                ...applyInputTitle(
                  thread,
                  prompt.trim() || images?.[0]?.name || "图片会话",
                  automatic,
                ),
                sessionRef: {
                  ...thread.sessionRef,
                  metadata: { ...thread.sessionRef.metadata, modifiedAt: admission.startedAt },
                },
              })).pipe(Effect.catch((error) => Effect.logError(error.message)));
              if (titleModel) {
                yield* Effect.tryPromise({
                  try: () => startTitle(runtime, titleModel, admission.operationId),
                  catch: (error) => error,
                }).pipe(Effect.catch((error) => Effect.logError(error)));
              }
              return admission;
            }),
          ),
        stop: (id) =>
          locked(
            Effect.gen(function* () {
              yield* runs.stop(yield* runtimeFor(id));
            }),
          ),
        resume: (id) =>
          locked(
            Effect.gen(function* () {
              yield* runs.resume(yield* runtimeFor(id, true));
            }),
          ),
        compact: (id) =>
          locked(
            Effect.gen(function* () {
              yield* runs.compact(yield* runtimeFor(id, true));
            }),
          ),
        configure: (id, provider, modelId, level) =>
          locked(
            Effect.gen(function* () {
              yield* conversations.configure(yield* runtimeFor(id, true), provider, modelId, level);
              return yield* open(id);
            }),
          ),
        subscribe: (id, onSnapshot, onError, path) =>
          Effect.gen(function* () {
            const runtime = yield* runtimeFor(id);
            const target = path
              ? yield* adapter("无法订阅子智能体", () => childRuntime(runtime, path))
              : runtime;
            return yield* observations.subscribe(target, onSnapshot, onError);
          }),
      });
    }),
  );
}
