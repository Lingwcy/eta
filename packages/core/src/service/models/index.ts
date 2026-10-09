import type { Models, CredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Context, Effect, Layer } from "effect";
import type { AgentModel } from "../../agent/protocol.ts";
import { toAgentModel } from "../../agent/model.ts";
import { adapter, CoreError } from "../errors.ts";
import type { RuntimeSettings } from "../../shared/runtime-settings.ts";

export class ModelCatalogService extends Context.Service<
  ModelCatalogService,
  {
    readonly models: Models;
    readonly list: Effect.Effect<ReadonlyArray<AgentModel>, CoreError>;
    select(settings: RuntimeSettings): Effect.Effect<AgentModel, CoreError>;
    available(provider: string, modelId: string): Effect.Effect<boolean, CoreError>;
  }
>()("eta/core/service/models/ModelCatalogService") {
  static readonly layerWithCredentials = (credentials: CredentialStore) =>
    ModelCatalogService.layerWith(builtinModels({ credentials }));
  /** Models is the provider boundary; tests inject a faux catalog, not a second runtime implementation. */
  static readonly layerWith = (models: Models) => Layer.succeed(ModelCatalogService, make(models));
}

function make(models: Models) {
  const list = adapter("无法读取模型列表", async () => {
    await models.refresh({ signal: AbortSignal.timeout(5000) });
    const available = (
      await Promise.all(
        models.getProviders().map((provider) => models.getAvailable(provider.id).catch(() => [])),
      )
    ).flat();
    return available.map(toAgentModel);
  });
  return ModelCatalogService.of({
    models,
    list,
    select: Effect.fn("ModelCatalogService.select")(function* (settings: RuntimeSettings) {
      const model = (yield* list).find(
        (model) =>
          (!settings.defaultProvider || model.provider === settings.defaultProvider) &&
          (!settings.defaultModel || model.id === settings.defaultModel),
      );
      if (!model)
        return yield* new CoreError({
          code: "ModelUnavailable",
          message: "选定模型不可用，请在设置中配置认证和默认模型",
        });
      return model;
    }),
    available: (provider, modelId) =>
      adapter("无法检查模型认证", async () =>
        (await models.getAvailable(provider)).some((model) => model.id === modelId),
      ),
  });
}
