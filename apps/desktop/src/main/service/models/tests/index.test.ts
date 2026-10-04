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

test("model capabilities survive transport and follow the provider's per-model thinking map", async () => {
  const models = createModels();
  const basic = fauxProvider({
    provider: "basic",
    models: [{ id: "same", reasoning: true }, { id: "plain" }],
  }).provider;
  models.setProvider(basic);
  const extended = fauxProvider({
    provider: "extended",
    models: [{ id: "same", reasoning: true }],
  }).provider;
  models.setProvider({
    ...extended,
    getModels: () =>
      extended.getModels().map((model) => ({
        ...model,
        thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
      })),
  });
  const runtime = ManagedRuntime.make(ModelCatalogService.layerWith(models));
  try {
    const catalog = await runtime.runPromise(ModelCatalogService);
    const list = JSON.parse(JSON.stringify(await runtime.runPromise(catalog.list)));
    expect(list).toMatchObject([
      {
        provider: "basic",
        id: "same",
        thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      },
      { provider: "basic", id: "plain", thinkingLevels: ["off"] },
      {
        provider: "extended",
        id: "same",
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);
  } finally {
    await runtime.dispose();
  }
});
