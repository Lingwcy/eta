import { Context, Effect, Layer, SynchronizedRef } from "effect";
import { CatalogStoreService } from "./json-store.ts";
import type { CatalogError } from "./json-store.ts";
import { CATALOG_VERSION, decodeCatalog } from "./schema.ts";
import type { CatalogState } from "./type.ts";

export class DesktopCatalogService extends Context.Service<
  DesktopCatalogService,
  {
    readonly read: Effect.Effect<CatalogState>;
    update(
      transform: (state: CatalogState) => CatalogState,
    ): Effect.Effect<CatalogState, CatalogError>;
  }
>()("eta/desktop/main/service/catalog/DesktopCatalogService") {
  static readonly layer = Layer.effect(
    DesktopCatalogService,
    Effect.gen(function* () {
      const store = yield* CatalogStoreService;
      const state = yield* SynchronizedRef.make(yield* store.load);
      const read = SynchronizedRef.get(state).pipe(Effect.map((value) => structuredClone(value)));

      const update = Effect.fn("DesktopCatalogService.update")(
        (transform: (state: CatalogState) => CatalogState) =>
          SynchronizedRef.modifyEffect(
            state,
            Effect.fnUntraced(function* (current) {
              const next = transform(structuredClone(current));
              const valid = yield* decodeCatalog({ version: CATALOG_VERSION, ...next });
              yield* store.save(valid);
              return [structuredClone(valid), valid] as const;
            }),
          ).pipe(Effect.uninterruptible),
      );

      return DesktopCatalogService.of({ read, update });
    }),
  );
}
