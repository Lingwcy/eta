import { expect, test } from "vite-plus/test";
import { clampThinkingLevel, createModels, fauxProvider } from "@earendil-works/pi-ai";
import { toAgentModel } from "../../../../src/agent/model.ts";
import { resolveThinkingLevel, thinkingOptions } from "./model-thinking";

test("picker options and model switching agree with the provider capability policy", () => {
  const models = createModels();
  const provider = fauxProvider({
    models: [
      { id: "plain" },
      { id: "basic", reasoning: true },
      { id: "extended", reasoning: true },
    ],
  }).provider;
  models.setProvider({
    ...provider,
    getModels: () =>
      provider.getModels().map((model) =>
        model.id === "extended"
          ? {
              ...model,
              thinkingLevelMap: {
                off: null,
                minimal: null,
                medium: null,
                xhigh: "xhigh",
                max: "max",
              },
            }
          : model,
      ),
  });
  const [plain, basic, extended] = models.getModels().map(toAgentModel);
  expect(
    thinkingOptions
      .filter((option) => plain!.thinkingLevels.includes(option.value))
      .map((option) => option.value),
  ).toEqual(["off"]);
  expect(resolveThinkingLevel(basic, "max")).toBe("high");
  expect(resolveThinkingLevel(plain, "high")).toBe("off");
  expect(resolveThinkingLevel(extended, "off")).toBe("low");
  expect(resolveThinkingLevel(extended, "medium")).toBe("high");
  expect(resolveThinkingLevel(extended, "max")).toBe("max");
  for (const model of models.getModels()) {
    for (const { value } of thinkingOptions) {
      expect(resolveThinkingLevel(toAgentModel(model), value)).toBe(
        clampThinkingLevel(model, value),
      );
    }
  }
  expect(resolveThinkingLevel(undefined, "high")).toBe("off");
});
