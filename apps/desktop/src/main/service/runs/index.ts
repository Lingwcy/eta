import { AgentResourcesService } from "../resources/index.ts";
import { imageInput } from "../../../images/content.ts";
import type { ImageAttachment } from "../../../images/types.ts";
import { realpath, stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Context, DateTime, Effect, Layer } from "effect";
import type { OperationAdmission } from "../../../agent/protocol.ts";
import { adapter, DesktopServiceError } from "../errors.ts";
import { ModelCatalogService } from "../models/index.ts";
import type { ThreadRuntime } from "../runtime/index.ts";

export class RunSupervisorService extends Context.Service<
  RunSupervisorService,
  {
    submit(
      runtime: ThreadRuntime,
      prompt: string,
      requestId?: string,
      images?: readonly ImageAttachment[],
    ): Effect.Effect<OperationAdmission, DesktopServiceError>;
    resume(runtime: ThreadRuntime): Effect.Effect<void, DesktopServiceError>;
    stop(runtime: ThreadRuntime): Effect.Effect<void, DesktopServiceError>;
    compact(runtime: ThreadRuntime): Effect.Effect<void, DesktopServiceError>;
    blockedReason(runtime: ThreadRuntime): Effect.Effect<string | undefined, DesktopServiceError>;
  }
>()("eta/desktop/main/service/runs/RunSupervisorService") {
  static readonly layer = Layer.effect(
    RunSupervisorService,
    Effect.gen(function* () {
      const models = yield* ModelCatalogService;
      const resources = yield* AgentResourcesService;
      const leases = new Map<string, ThreadRuntime>();
      const executions = new Map<ThreadRuntime, Promise<unknown>>();
      const changed = (runtime: ThreadRuntime) => {
        for (const notify of runtime.changes) notify();
      };
      const blockedReason = Effect.fn("RunSupervisorService.blockedReason")(function* (
        runtime: ThreadRuntime,
      ) {
        const exists = yield* adapter("无法检查工作区", async () =>
          Promise.all([stat(runtime.ref.metadata.cwd), realpath(runtime.ref.metadata.cwd)])
            .then(
              ([value, canonical]) => value.isDirectory() && canonical === runtime.ref.metadata.cwd,
            )
            .catch(() => false),
        );
        if (!exists) return "工作区目录不可用，历史仍可查看";
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
      const ready = Effect.fn("RunSupervisorService.ready")(function* (runtime: ThreadRuntime) {
        if (runtime.disposed)
          return yield* new DesktopServiceError({
            code: "RuntimeClosing",
            message: "会话正在关闭",
          });
        const blocked = yield* blockedReason(runtime);
        if (blocked)
          return yield* new DesktopServiceError({
            code: blocked.startsWith("工作区") ? "WorkspaceUnavailable" : "ModelUnavailable",
            message: blocked,
          });
        if (leases.has(runtime.ref.metadata.cwd))
          return yield* new DesktopServiceError({
            code: "Busy",
            message: "此工作区已有任务运行，请等待或停止该任务",
          });
      });
      const claim = (runtime: ThreadRuntime) => {
        if (leases.has(runtime.ref.metadata.cwd))
          throw new DesktopServiceError({ code: "Busy", message: "此工作区已有任务运行" });
        leases.set(runtime.ref.metadata.cwd, runtime);
        runtime.running = true;
      };
      const release = (runtime: ThreadRuntime) => {
        if (leases.get(runtime.ref.metadata.cwd) === runtime)
          leases.delete(runtime.ref.metadata.cwd);
        runtime.running = false;
        executions.delete(runtime);
        changed(runtime);
      };
      const supervise = (runtime: ThreadRuntime, settled: Promise<unknown>) => {
        const execution = settled
          .catch((error: unknown) => {
            if (!runtime.disposed)
              runtime.error = error instanceof Error ? error.message : "执行失败";
          })
          .finally(() => release(runtime));
        executions.set(runtime, execution);
      };
      return RunSupervisorService.of({
        blockedReason,
        submit: Effect.fn("RunSupervisorService.submit")(function* (
          runtime: ThreadRuntime,
          prompt: string,
          requestId?: string,
          images?: readonly ImageAttachment[],
        ) {
          const content = yield* adapter(
            "图片或消息无效",
            async () => imageInput(prompt, images, (32 * 1024 * 1024 * 4) / 3),
            "InvalidInput",
          );
          if (requestId) {
            const existing = yield* adapter("无法查询已提交请求", () =>
              runtime.storage.submissionByRequest(
                runtime.conversation.id,
                requestId,
                BACKGROUND_CONTEXT,
              ),
            );
            if (existing) {
              const entry =
                existing.entry === undefined
                  ? undefined
                  : yield* adapter("无法读取提交记录", () =>
                      runtime.storage.entry(existing.entry!, BACKGROUND_CONTEXT),
                    );
              return {
                operationId: String(existing.id),
                kind: "run" as const,
                startedAt: entry?.entry.model?.[0]?.timestamp ?? runtime.ref.metadata.createdAt,
              };
            }
          }
          if (runtime.recoveryRequired)
            return yield* new DesktopServiceError({
              code: "RecoveryRequired",
              message: "请先恢复或停止未完成任务",
            });
          yield* ready(runtime);
          const agent = yield* adapter("无法读取图片模型限制", () =>
            runtime.conversation.agent(BACKGROUND_CONTEXT),
          );
          const model =
            agent.model && models.models.getModel(agent.model.provider, agent.model.modelId);
          const maximum = model?.inputLimits?.images?.maxPerMessage;
          if (maximum && images && images.length > maximum)
            return yield* new DesktopServiceError({
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
          const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
          return yield* adapter("无法提交消息", async () => {
            claim(runtime);
            try {
              const handle = await runtime.conversation.submit(
                {
                  type: "input",
                  content: input,
                  whenBusy: "reject",
                  ...(requestId ? { requestId } : {}),
                },
                BACKGROUND_CONTEXT,
              );
              supervise(runtime, handle.wait(BACKGROUND_CONTEXT));
              return { operationId: String(handle.id), kind: "run" as const, startedAt };
            } catch (error) {
              release(runtime);
              throw error;
            }
          });
        }, Effect.uninterruptible),
        resume: Effect.fn("RunSupervisorService.resume")(function* (runtime: ThreadRuntime) {
          yield* ready(runtime);
          yield* adapter("无法恢复任务", async () => {
            claim(runtime);
            runtime.recoveryRequired = false;
            runtime.harness.resume();
            supervise(runtime, runtime.harness.waitForIdle(BACKGROUND_CONTEXT));
            changed(runtime);
          });
        }, Effect.uninterruptible),
        stop: (runtime) =>
          adapter("无法停止任务", async () => {
            // abort also settles queued work; recovery is only resumed here to converge cancellation.
            if (!runtime.running) claim(runtime);
            try {
              runtime.recoveryRequired = false;
              await runtime.conversation.abort(BACKGROUND_CONTEXT, { background: true });
              await executions.get(runtime);
            } finally {
              release(runtime);
            }
          }).pipe(Effect.uninterruptible),
        compact: Effect.fn("RunSupervisorService.compact")(function* (runtime: ThreadRuntime) {
          if (runtime.recoveryRequired)
            return yield* new DesktopServiceError({
              code: "RecoveryRequired",
              message: "请先处理未完成任务",
            });
          yield* ready(runtime);
          yield* adapter("无法压缩上下文", async () => {
            claim(runtime);
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
