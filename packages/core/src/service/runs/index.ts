import { AgentResourcesService } from "../resources/index.ts";
import { imageInput } from "../../images/content.ts";
import type { ImageAttachment } from "../../images/types.ts";
import { realpath, stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Context, Effect, Layer } from "effect";
import { InboxDoc } from "@eta/agent";
import type { SubmissionRecord, Submission } from "@eta/agent";
import { randomUUID } from "node:crypto";
import { checkQueueCapacity, inputFingerprint, inputRecords, rememberInput } from "./inputs.ts";
import type { InputMode, OperationAdmission } from "../../agent/protocol.ts";
import { adapter, CoreError } from "../errors.ts";
import { ModelCatalogService } from "../models/index.ts";
import type { ThreadRuntime } from "../runtime/index.ts";
import { normalizeThinkingLevel } from "../conversations/thinking.ts";
import { WorkspaceAccessService } from "../git/workspace-access.ts";

export class RunSupervisorService extends Context.Service<
  RunSupervisorService,
  {
    submit(
      runtime: ThreadRuntime,
      prompt: string,
      requestId?: string,
      images?: readonly ImageAttachment[],
      whenBusy?: InputMode,
    ): Effect.Effect<OperationAdmission, CoreError>;
    resume(runtime: ThreadRuntime): Effect.Effect<void, CoreError>;
    stop(runtime: ThreadRuntime): Effect.Effect<void, CoreError>;
    compact(runtime: ThreadRuntime): Effect.Effect<void, CoreError>;
    subscribe(listener: () => void): () => void;
    blockedReason(runtime: ThreadRuntime): Effect.Effect<string | undefined, CoreError>;
  }
>()("eta/core/service/runs/RunSupervisorService") {
  static readonly layer = Layer.effect(
    RunSupervisorService,
    Effect.gen(function* () {
      const models = yield* ModelCatalogService;
      const resources = yield* AgentResourcesService;
      const access = yield* WorkspaceAccessService;
      type Lease = {
        kind: "run" | "control";
        closing: boolean;
        admission?: PromiseWithResolvers<void>;
      };
      const leases = new Map<ThreadRuntime, Lease>();
      const executions = new Map<ThreadRuntime, Promise<unknown>>();
      const inputs = new Map<ThreadRuntime, Submission>();
      const listeners = new Set<() => void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => listeners.clear()));
      const changed = (runtime: ThreadRuntime) => {
        for (const notify of runtime.changes) notify();
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* Observers cannot fail an admitted run. */
          }
        }
      };
      const blockedReason = Effect.fn("RunSupervisorService.blockedReason")(function* (
        runtime: ThreadRuntime,
      ) {
        const unavailable = yield* access.reason(runtime.ref.metadata.cwd);
        if (unavailable) return unavailable;
        const exists = yield* adapter("无法检查工作区", async () =>
          Promise.all([stat(runtime.ref.metadata.cwd), realpath(runtime.ref.metadata.cwd)])
            .then(
              ([value, canonical]) => value.isDirectory() && canonical === runtime.ref.metadata.cwd,
            )
            .catch(() => false),
        );
        if (!exists) return "工作区目录不可用，历史仍可查看";
        const sandbox = yield* adapter("无法检查沙盒", runtime.sandbox);
        if (!sandbox.available) return sandbox.reason ?? "沙盒不可用，执行已阻止";
        const agent = yield* adapter("无法读取模型配置", () =>
          runtime.conversation.agent(BACKGROUND_CONTEXT),
        );
        if (agent.cwd !== undefined && agent.cwd !== runtime.ref.metadata.cwd)
          return "工作区配置与会话记录不一致，拒绝在其他目录执行";
        if (
          !agent.model ||
          !(yield* models
            .available(agent.model.provider, agent.model.modelId)
            .pipe(Effect.catch(() => Effect.succeed(false))))
        )
          return "会话模型或认证不可用，请在设置中配置认证或更换会话模型";
        return undefined;
      });
      const ready = Effect.fn("RunSupervisorService.ready")(function* (
        runtime: ThreadRuntime,
        append = false,
      ) {
        if (runtime.disposed)
          return yield* new CoreError({
            code: "RuntimeClosing",
            message: "会话正在关闭",
          });
        const blocked = yield* blockedReason(runtime);
        if (blocked?.startsWith("工作区"))
          return yield* new CoreError({ code: "WorkspaceUnavailable", message: blocked });
        const sandbox = yield* adapter("无法检查沙盒", runtime.sandbox);
        if (!sandbox.available)
          return yield* new CoreError({
            code: "SandboxUnavailable",
            message: sandbox.reason ?? "沙盒不可用，执行已阻止",
          });
        if (blocked)
          return yield* new CoreError({
            code: blocked.startsWith("工作区") ? "WorkspaceUnavailable" : "ModelUnavailable",
            message: blocked,
          });
        const input = inputs.get(runtime);
        if (!append && input && leases.has(runtime)) {
          const receipt = yield* adapter("无法检查执行记录", () =>
            input.status(BACKGROUND_CONTEXT),
          );
          // A persisted terminal receipt can become visible just before the supervisor releases its lease.
          if (
            (receipt.status === "done" || receipt.status === "unanswered") &&
            !(yield* adapter("无法检查执行状态", runtime.hasWork))
          )
            yield* adapter("无法释放已完成执行", async () => {
              await executions.get(runtime);
            });
        }
        if (
          leases.has(runtime) &&
          (!append || leases.get(runtime)?.kind !== "run" || leases.get(runtime)?.closing)
        )
          return yield* new CoreError({
            code: "Busy",
            message: "此会话已有任务运行，请等待或停止该任务",
          });
        if (!runtime.recoveryRequired && !leases.has(runtime))
          yield* adapter("无法更新思考级别", () =>
            normalizeThinkingLevel(runtime.conversation, models.models),
          );
      });
      const reserve = (runtime: ThreadRuntime, kind: Lease["kind"] = "control") => {
        if (leases.has(runtime))
          throw new CoreError({ code: "Busy", message: "此会话已有任务运行" });
        const owner: Lease = { kind, closing: false };
        leases.set(runtime, owner);
        runtime.running = true;
        return owner;
      };
      const claim = async (runtime: ThreadRuntime, kind: Lease["kind"] = "control") => {
        if (access.removing(runtime.ref.metadata.cwd))
          throw new CoreError({ code: "WorkspaceUnavailable", message: "工作区正在移除" });
        // Removal must see this claim while its last asynchronous eligibility read is pending.
        const owner = reserve(runtime, kind);
        try {
          const reason = await Effect.runPromise(access.reason(runtime.ref.metadata.cwd));
          if (reason || access.removing(runtime.ref.metadata.cwd))
            throw new CoreError({
              code: "WorkspaceUnavailable",
              message: reason ?? "工作区正在移除",
            });
          return owner;
        } catch (error) {
          if (leases.get(runtime) === owner) {
            leases.delete(runtime);
            runtime.running = false;
          }
          throw error;
        }
      };
      const release = (runtime: ThreadRuntime, owner = leases.get(runtime)) => {
        if (leases.get(runtime) !== owner) return;
        leases.delete(runtime);
        runtime.running = false;
        executions.delete(runtime);
        inputs.delete(runtime);
        changed(runtime);
      };
      /** Run-scoped approvals end when the root conversation goes idle, even if background children continue. */
      const expireRunGrants = async (runtime: ThreadRuntime) => {
        try {
          if (!runtime.disposed) await runtime.approvals.expireRunGrants(runtime.conversation.id);
        } catch (error) {
          if (!runtime.disposed) Effect.runFork(Effect.logError(error));
        }
      };
      const supervise = (runtime: ThreadRuntime, settled: Promise<unknown>) => {
        const owner = leases.get(runtime)!;
        const execution = settled
          .then(async () => {
            for (;;) {
              await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
              if (leases.get(runtime) !== owner || runtime.disposed) return;
              if (owner.admission) {
                await owner.admission.promise;
                continue;
              }
              owner.closing = true;
              // Converge any legacy inbox left by a preserved failed run before releasing ownership.
              await runtime.conversation.commit(async (tx) => {
                const inbox = await tx.doc(InboxDoc, runtime.conversation.id);
                for (let index = inbox.items.length - 1; index >= 0; index--) {
                  const input = inbox.items[index]!;
                  if (input.mode === "write") continue;
                  tx.settleSubmission(input.id, { status: "unanswered", reason: "run_failed" });
                  inbox.items.splice(index, 1);
                }
              }, BACKGROUND_CONTEXT);
              if (owner.kind === "run" && leases.get(runtime) === owner)
                void expireRunGrants(runtime);
              return;
            }
          })
          .catch((error: unknown) => {
            if (!runtime.disposed && leases.get(runtime) === owner)
              runtime.error = error instanceof Error ? error.message : "执行失败";
          })
          .finally(() => release(runtime, owner));
        executions.set(runtime, execution);
      };
      return RunSupervisorService.of({
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        blockedReason,
        submit: Effect.fn("RunSupervisorService.submit")(function* (
          runtime: ThreadRuntime,
          prompt: string,
          requestId?: string,
          images?: readonly ImageAttachment[],
          whenBusy: InputMode = "reject",
        ) {
          const content = yield* adapter(
            "图片或消息无效",
            async () => imageInput(prompt, images, (32 * 1024 * 1024 * 4) / 3),
            "InvalidInput",
          );
          if (!["reject", "steer", "followUp"].includes(whenBusy))
            return yield* new CoreError({ code: "InvalidInput", message: "消息模式无效" });
          const fingerprint = inputFingerprint(prompt, images, whenBusy);
          const previous = requestId
            ? (yield* adapter("无法检查消息身份", () => inputRecords(runtime))).find(
                (record) => record.requestId === requestId,
              )
            : undefined;
          if (previous && previous.fingerprint !== fingerprint)
            return yield* new CoreError({
              code: "InvalidInput",
              message: "请求标识已用于另一条消息或模式",
            });
          if (requestId) {
            const existing = yield* adapter("无法查询已提交请求", () =>
              runtime.storage.submissionByRequest(
                runtime.conversation.id,
                requestId,
                BACKGROUND_CONTEXT,
              ),
            );
            if (existing) {
              if (previous && previous.id === undefined)
                yield* adapter("无法保存消息身份", () =>
                  rememberInput(runtime, { ...previous, id: existing.id }),
                );
              return yield* adapter("无法读取提交记录", () => admission(runtime, existing));
            }
          }
          if (runtime.recoveryRequired)
            return yield* new CoreError({
              code: "RecoveryRequired",
              message: "请先恢复或停止未完成任务",
            });
          const owner = leases.get(runtime);
          const append = whenBusy !== "reject" && owner?.kind === "run" && !owner.closing;
          if (append) owner.admission = Promise.withResolvers<void>();
          const admissionGate = append ? owner.admission : undefined;
          const work = Effect.gen(function* () {
            yield* ready(runtime, append);
            if (!append) yield* adapter("无法更新工具配置", runtime.refreshTools);
            const agent = yield* adapter("无法读取图片模型限制", () =>
              runtime.conversation.agent(BACKGROUND_CONTEXT),
            );
            const model =
              agent.model && models.models.getModel(agent.model.provider, agent.model.modelId);
            const maximum = model?.inputLimits?.images?.maxPerMessage;
            if (maximum && images && images.length > maximum)
              return yield* new CoreError({
                code: "InvalidInput",
                message: `当前模型每条消息最多支持 ${maximum} 张图片`,
              });
            const prepared =
              images?.length && resources.processImage
                ? yield* adapter(
                    "无法处理图片",
                    () =>
                      Promise.all(
                        images.map(async (image) => {
                          const next = await resources.processImage!(
                            Buffer.from(image.data, "base64"),
                            image.name ?? "image.png",
                            model?.inputLimits?.images?.resize,
                          );
                          return {
                            ...next,
                            note:
                              [...new Set([image.note, next.note].filter(Boolean))].join("\n") ||
                              undefined,
                          };
                        }),
                      ),
                    "InvalidInput",
                  )
                : images;
            const input = prepared?.length ? imageInput(prompt, prepared) : content;
            const handle = yield* adapter("无法提交消息", async () => {
              if (append && (leases.get(runtime) !== owner || owner.closing || runtime.disposed))
                throw new CoreError({ code: "Busy", message: "执行已结束或正在停止，请重新发送" });
              if (!append) await claim(runtime, "run");
              const admittedOwner = leases.get(runtime)!;
              let submitted = false;
              try {
                await checkQueueCapacity(runtime, input);
                if (!append) await runtime.prepareMode();
                if (!append) await runtime.prepareSkills(prompt);
                if (
                  runtime.disposed ||
                  leases.get(runtime) !== admittedOwner ||
                  admittedOwner.closing
                )
                  throw new CoreError({
                    code: "Busy",
                    message: "执行已结束或正在停止，请重新发送",
                  });
                const identity = requestId ?? randomUUID();
                const record = {
                  requestId: identity,
                  fingerprint,
                  prompt,
                  mode: whenBusy,
                  submittedAt: previous ? previous.submittedAt : Date.now(),
                  images: (prepared ?? []).map(({ name, mimeType, note }) => ({
                    ...(name ? { name } : {}),
                    mimeType,
                    ...(note ? { note } : {}),
                  })),
                };
                await rememberInput(runtime, record, input);
                if (
                  runtime.disposed ||
                  leases.get(runtime) !== admittedOwner ||
                  admittedOwner.closing
                )
                  throw new CoreError({
                    code: "Busy",
                    message: "执行已结束或正在停止，请重新发送",
                  });
                const handle = await runtime.conversation.submit(
                  {
                    type: "input",
                    content: input,
                    whenBusy,
                    requestId: identity,
                  },
                  BACKGROUND_CONTEXT,
                );
                submitted = true;
                if (!append) {
                  inputs.set(runtime, handle);
                  const settled = handle.wait(BACKGROUND_CONTEXT);
                  supervise(runtime, settled);
                }
                await rememberInput(runtime, { ...record, id: handle.id });
                changed(runtime);
                return handle;
              } catch (error) {
                if (!append && !submitted) release(runtime, admittedOwner);
                throw error;
              }
            });
            return yield* adapter("无法读取提交记录", async () =>
              admission(runtime, await handle.status(BACKGROUND_CONTEXT)),
            );
          });
          return yield* work.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                admissionGate?.resolve();
                if (owner && owner.admission === admissionGate) delete owner.admission;
              }),
            ),
          );
        }, Effect.uninterruptible),
        resume: Effect.fn("RunSupervisorService.resume")(function* (runtime: ThreadRuntime) {
          yield* ready(runtime);
          yield* adapter("无法更新工具配置", runtime.refreshTools);
          yield* adapter("无法恢复任务", async () => {
            await claim(runtime, "run");
            runtime.recoveryRequired = false;
            await runtime.subagents.wake();
            runtime.harness.resume();
            // Background children report through durable tasks; only the root turn reserves input.
            supervise(runtime, runtime.conversation.waitForIdle(BACKGROUND_CONTEXT));
            changed(runtime);
          });
        }, Effect.uninterruptible),
        stop: (runtime) =>
          adapter("无法停止任务", async () => {
            // abort also settles queued work; recovery is only resumed here to converge cancellation.
            // Cancellation must remain possible after the checkout is lost or tombstoned.
            if (!runtime.running) reserve(runtime);
            const owner = leases.get(runtime)!;
            owner.closing = true;
            try {
              runtime.recoveryRequired = false;
              await runtime.subagents.stopAll();
              await runtime.revokeSandboxGrants();
              await executions.get(runtime);
            } finally {
              release(runtime, owner);
            }
          }).pipe(Effect.uninterruptible),
        compact: Effect.fn("RunSupervisorService.compact")(function* (runtime: ThreadRuntime) {
          if (runtime.recoveryRequired)
            return yield* new CoreError({
              code: "RecoveryRequired",
              message: "请先处理未完成任务",
            });
          yield* ready(runtime);
          yield* adapter("无法更新工具配置", runtime.refreshTools);
          yield* adapter("无法压缩上下文", async () => {
            await claim(runtime);
            try {
              const task = await runtime.conversation.compact(undefined, BACKGROUND_CONTEXT);
              supervise(runtime, runtime.harness.waitForTask(task, BACKGROUND_CONTEXT));
            } catch (error) {
              release(runtime);
              throw error;
            }
          });
        }, Effect.uninterruptible),
      });
    }),
  );
}

/** Use the durable input timestamp for both initial admission and retries, including after restart. */
async function admission(
  runtime: ThreadRuntime,
  receipt: SubmissionRecord,
): Promise<OperationAdmission> {
  const entry =
    receipt.entry === undefined
      ? undefined
      : await runtime.storage.entry(receipt.entry, BACKGROUND_CONTEXT);
  return {
    ...(entry?.entry.model?.some((message) => message.role === "user")
      ? {
          inputEntryId: `${receipt.entry}:${entry.entry.model.findIndex((message) => message.role === "user")}`,
        }
      : {}),
    operationId: String(receipt.id),
    status:
      receipt.status === "done"
        ? "completed"
        : receipt.status === "unanswered"
          ? receipt.reason === "aborted"
            ? "aborted"
            : "failed"
          : receipt.status === "queued"
            ? "queued"
            : "running",
    kind: "run",
    startedAt:
      (await inputRecords(runtime)).find(
        (record) => record.id === receipt.id || record.requestId === receipt.requestId,
      )?.submittedAt ??
      entry?.entry.model?.[0]?.timestamp ??
      runtime.ref.metadata.createdAt,
  };
}
