import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Context, Effect, Layer } from "effect";
import type { AgentModel, ThinkingLevel } from "../../../agent/protocol.ts";
import { adapter, DesktopServiceError } from "../errors.ts";
import { ModelCatalogService } from "../models/index.ts";
import type { ThreadRuntime } from "../runtime/index.ts";

export class ConversationService extends Context.Service<
  ConversationService,
  {
    model(runtime: ThreadRuntime): Effect.Effect<AgentModel, DesktopServiceError>;
    configure(
      runtime: ThreadRuntime,
      provider: string,
      modelId: string,
      thinkingLevel: ThinkingLevel,
    ): Effect.Effect<void, DesktopServiceError>;
  }
>()("eta/desktop/main/service/conversations/ConversationService") {
  static readonly layer = Layer.effect(
    ConversationService,
    Effect.gen(function* () {
      const models = yield* ModelCatalogService;
      return ConversationService.of({
        model: Effect.fn("ConversationService.model")(function* (runtime: ThreadRuntime) {
          const agent = yield* adapter("无法读取会话配置", () =>
            runtime.conversation.agent(BACKGROUND_CONTEXT),
          );
          const model =
            agent.model && models.models.getModel(agent.model.provider, agent.model.modelId);
          // History has an identity even if the provider is no longer configured.
          return model
            ? {
                id: model.id,
                provider: model.provider,
                name: model.name,
                contextWindow: model.contextWindow,
              }
            : {
                id: agent.model?.modelId ?? "unknown",
                provider: agent.model?.provider ?? "unknown",
                name: agent.model?.modelId ?? "未知模型",
                contextWindow: 0,
              };
        }),
        configure: Effect.fn("ConversationService.configure")(function* (
          runtime: ThreadRuntime,
          provider: string,
          modelId: string,
          thinkingLevel: ThinkingLevel,
        ) {
          if (runtime.running || runtime.recoveryRequired)
            return yield* new DesktopServiceError({
              code: "Busy",
              message: "请先停止或完成当前任务，再修改模型",
            });
          if (!(yield* models.available(provider, modelId)))
            return yield* new DesktopServiceError({
              code: "ModelUnavailable",
              message: "模型不可用",
            });
          yield* adapter("无法保存会话配置", () =>
            runtime.conversation.configure(
              {
                model: { provider, modelId },
                thinkingLevel: thinkingLevel === "off" ? null : thinkingLevel,
              },
              BACKGROUND_CONTEXT,
            ),
          );
          runtime.error = undefined;
          runtime.blockedReason = undefined;
          for (const notify of runtime.changes) notify();
        }),
      });
    }),
  );
}
