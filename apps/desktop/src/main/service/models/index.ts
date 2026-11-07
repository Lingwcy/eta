import { Effect, Layer } from "effect";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelCatalogService as CoreModelCatalogService } from "@eta/core/service/models/index";
import { CredentialService } from "@eta/core/service/credentials/index";
import { loadMagpieProvider } from "@eta/core/service/models/magpie";

export class ModelCatalogService extends CoreModelCatalogService {
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const { store } = yield* CredentialService;
      const models = builtinModels({ credentials: store });
      // Magpie owns this opt-in file. A broken integration must not prevent normal startup.
      const magpie = yield* Effect.tryPromise(() => loadMagpieProvider()).pipe(
        Effect.catch(() =>
          Effect.logWarning(
            "Magpie configuration is invalid or unreadable; integration skipped",
          ).pipe(Effect.as(undefined)),
        ),
      );
      if (magpie) {
        models.setProvider(magpie);
        // Restored threads and schedules resolve models before the client opens a picker.
        yield* Effect.tryPromise((signal) =>
          models.refresh({
            providers: ["magpie"],
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          }),
        ).pipe(
          Effect.flatMap((result) =>
            result.errors.size || result.aborted
              ? Effect.logWarning("Magpie model discovery failed; other providers remain available")
              : Effect.void,
          ),
          Effect.catch(() =>
            Effect.logWarning("Magpie model discovery failed; other providers remain available"),
          ),
        );
      }
      return CoreModelCatalogService.layerWith(models);
    }),
  );
}
