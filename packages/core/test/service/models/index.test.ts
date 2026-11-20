import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Effect, ManagedRuntime } from "effect";
import { expect, test } from "vite-plus/test";
import { toAgentModel } from "@eta/core/agent/model";
import {
  createBuiltinModels,
  ModelCatalogService,
  supplementBuiltinModels,
} from "@eta/core/service/models/index";

test("one broken provider cannot hide other models or block browsing the model catalog", async () => {
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

test("builtin catalog exposes GPT-6.2 Sol and GPT-6.2 Astra on OpenAI, Codex, and Azure", () => {
  const models = createBuiltinModels();

  const expected = [
    {
      provider: "openai",
      id: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      contextWindow: 272000,
      inputCost: 2,
      outputCost: 10,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      provider: "openai",
      id: "gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      contextWindow: 272000,
      inputCost: 8,
      outputCost: 40,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      provider: "openai-codex",
      id: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      contextWindow: 500000,
      inputCost: 2,
      outputCost: 10,
      thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
    },
    {
      provider: "openai-codex",
      id: "gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      contextWindow: 272000,
      inputCost: 8,
      outputCost: 40,
      thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
    },
    {
      provider: "azure",
      id: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      contextWindow: 1050000,
      inputCost: 2,
      outputCost: 10,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      provider: "azure",
      id: "gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      contextWindow: 1050000,
      inputCost: 8,
      outputCost: 40,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    },
  ] as const;

  for (const item of expected) {
    const model = models.getModel(item.provider, item.id);
    expect(model, `${item.provider}/${item.id}`).toBeDefined();
    expect(model?.name).toBe(item.name);
    expect(model?.contextWindow).toBe(item.contextWindow);
    expect(model?.cost.input).toBe(item.inputCost);
    expect(model?.cost.output).toBe(item.outputCost);
    expect(model?.cost.tiers).toEqual([
      {
        inputTokensAbove: 272000,
        input: item.inputCost * 2,
        output: item.outputCost * 1.5,
        cacheRead: model!.cost.cacheRead * 2,
        cacheWrite: model!.cost.cacheWrite * 2,
      },
    ]);
    expect(toAgentModel(model!).thinkingLevels).toEqual(item.thinkingLevels);
    expect(models.getAllModels(item.provider).some((entry) => entry.id === item.id)).toBe(true);
  }

  // Non-chat models on supplemented providers stay intact.
  expect(models.getAllModels("openai").some((entry) => entry.type && entry.type !== "chat")).toBe(
    true,
  );
});

test("supplementBuiltinModels does not duplicate models already provided upstream", () => {
  const models = createModels();
  models.setProvider(
    fauxProvider({
      provider: "openai",
      models: [
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", contextWindow: 272000 },
        { id: "gpt-6.2-sol", name: "Upstream GPT-6.2 Sol", contextWindow: 999999 },
      ],
    }).provider,
  );

  supplementBuiltinModels(models);

  const ids = models.getModels("openai").map((model) => model.id);
  expect(ids.filter((id) => id === "gpt-6.2-sol")).toHaveLength(1);
  expect(models.getModel("openai", "gpt-6.2-sol")).toMatchObject({
    name: "Upstream GPT-6.2 Sol",
    contextWindow: 999999,
  });
  expect(models.getModel("openai", "gpt-6.2-astra")).toMatchObject({
    name: "GPT-6.2 Astra",
    contextWindow: 272000,
  });
});
