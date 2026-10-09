import { Context, Effect, Layer, SynchronizedRef } from "effect";
import { CatalogStoreService } from "./json-store.ts";
import type { CatalogError } from "./json-store.ts";
import { CATALOG_VERSION, decodeCatalog } from "./schema.ts";
import type { CatalogState } from "../../../shared/catalog.ts";

export class DesktopCatalogService extends Context.Service<
  DesktopCatalogService,
  {
    readonly read: Effect.Effect<CatalogState>;
    subscribe(listener: () => void): () => void;
    update(
      transform: (state: CatalogState) => CatalogState,
    ): Effect.Effect<CatalogState, CatalogError>;
  }
>()("eta/desktop/main/service/catalog/DesktopCatalogService") {
  static readonly layer = Layer.effect(
    DesktopCatalogService,
    Effect.gen(function* () {
      const store = yield* CatalogStoreService;
      const listeners = new Set<() => void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => listeners.clear()));
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
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                for (const listener of listeners) {
                  try {
                    listener();
                  } catch (error) {
                    console.error("Catalog listener failed", error);
                  }
                }
              }),
            ),
            Effect.uninterruptible,
          ),
      );

      return DesktopCatalogService.of({
        read,
        update,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
    }),
  );
}
