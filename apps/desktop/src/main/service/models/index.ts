import { Effect, Layer } from "effect";
import { ModelCatalogService as CoreModelCatalogService } from "@eta/core/service/models/index";
import { CredentialService } from "@eta/core/service/credentials/index";

export class ModelCatalogService extends CoreModelCatalogService {
  static readonly layer = Layer.unwrap(
    Effect.map(CredentialService, ({ store }) =>
      CoreModelCatalogService.layerWithCredentials(store),
    ),
  );
}
