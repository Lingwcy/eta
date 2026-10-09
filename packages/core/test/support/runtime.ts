import { join, dirname } from "node:path";
import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect";
import type { Models } from "@earendil-works/pi-ai";
import { coreServices } from "../../src/layer.ts";
import type { ImageProcessor } from "../../src/images/types.ts";
import { readJson, writeJson } from "../../src/service/json-file.ts";
import { RuntimeSettingsSchema } from "../../src/shared/runtime-settings.ts";
import type { RuntimeSettings } from "../../src/shared/runtime-settings.ts";
import type { RuntimeSettingsService } from "../../src/service/settings/index.ts";

/** A test host persists its preferences and publishes updates independently of Core. */
export class TestSettings extends Context.Service<
  TestSettings,
  RuntimeSettingsService["Service"] & {
    update(patch: Partial<RuntimeSettings>): Effect.Effect<RuntimeSettings>;
  }
>()("eta/core/test/TestSettings") {}

export function testServices(
  dataRoot: string,
  models: Models,
  processImage?: ImageProcessor,
  home = dirname(dataRoot),
) {
  const preferences = Layer.effect(
    TestSettings,
    Effect.gen(function* () {
      const path = join(dataRoot, "test-settings.json");
      const initial = yield* Effect.promise(async () =>
        Schema.decodeUnknownSync(RuntimeSettingsSchema)(
          (await readJson(path)) ?? { defaultThinkingLevel: "off" },
        ),
      );
      const state = yield* SynchronizedRef.make(initial);
      const listeners = new Set<() => void>();
      return TestSettings.of({
        read: SynchronizedRef.get(state).pipe(Effect.map((value) => structuredClone(value))),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        update: (patch) =>
          SynchronizedRef.modifyEffect(state, (current) =>
            Effect.promise(async () => {
              const next = Schema.decodeUnknownSync(RuntimeSettingsSchema)({
                ...current,
                ...patch,
              });
              await writeJson(path, next);
              return [structuredClone(next), next] as const;
            }),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                for (const listener of listeners) listener();
              }),
            ),
          ),
      });
    }),
  );
  return Layer.unwrap(
    Effect.map(TestSettings, (settings) =>
      coreServices({
        dataRoot,
        home,
        models,
        settings,
        ...(processImage ? { processImage } : {}),
        environment: { userAgent: "eta-core-test", shutdown: "abortForeground" },
      }),
    ),
  ).pipe(Layer.provideMerge(preferences));
}
