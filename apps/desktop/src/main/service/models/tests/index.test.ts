import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Effect, ManagedRuntime } from "effect";
import { expect, test } from "vite-plus/test";
import { ModelCatalogService } from "../index.ts";

test("one broken provider cannot hide other models or block browsing the desktop library", async () => {
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "good", models: [{ id: "one" }] }).provider);
  const broken = fauxProvider({ provider: "broken", models: [{ id: "bad" }] }).provider;
  models.setProvider({
    ...broken,
    auth: {
      apiKey: {
        name: "Broken credentials",
        resolve: async () => {
          throw new Error("Auth unavailable");
        },
      },
    },
  });
  const runtime = ManagedRuntime.make(ModelCatalogService.layerWith(models));
  try {
    const catalog = await runtime.runPromise(ModelCatalogService);
    expect((await runtime.runPromise(catalog.list)).map((model) => model.provider)).toEqual([
      "good",
    ]);
    expect(
      await runtime.runPromise(
        Effect.flip(catalog.select({ defaultProvider: "broken", defaultThinkingLevel: "off" })),
      ),
    ).toMatchObject({ code: "ModelUnavailable" });
  } finally {
    await runtime.dispose();
  }
});
