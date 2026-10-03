import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Context, Effect, Layer } from "effect";
import type { AgentModel } from "../../../agent/protocol.ts";
import { CredentialService } from "../credentials/index.ts";
import { adapter, DesktopServiceError } from "../errors.ts";
import type { DesktopSettings } from "../settings/index.ts";

export class ModelCatalogService extends Context.Service<
  ModelCatalogService,
  {
    readonly models: Models;
    readonly list: Effect.Effect<ReadonlyArray<AgentModel>, DesktopServiceError>;
    select(settings: DesktopSettings): Effect.Effect<AgentModel, DesktopServiceError>;
    available(provider: string, modelId: string): Effect.Effect<boolean, DesktopServiceError>;
  }
>()("eta/desktop/main/service/models/ModelCatalogService") {
  static readonly layer = Layer.effect(
    ModelCatalogService,
    Effect.gen(function* () {
      const credentials = yield* CredentialService;
      return make(builtinModels({ credentials: credentials.store }));
    }),
  );
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
    return available.map(({ id, provider, name, contextWindow }) => ({
      id,
      provider,
      name,
      contextWindow,
    }));
  });
  return ModelCatalogService.of({
    models,
    list,
    select: Effect.fn("ModelCatalogService.select")(function* (settings: DesktopSettings) {
      const model = (yield* list).find(
        (model) =>
          (!settings.defaultProvider || model.provider === settings.defaultProvider) &&
          (!settings.defaultModel || model.id === settings.defaultModel),
      );
      if (!model)
        return yield* new DesktopServiceError({
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
