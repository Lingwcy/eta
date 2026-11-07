import { expect, test } from "vite-plus/test";
import { modelPickerProviders, visiblePickerModels } from "./model-picker-options";
import type { InputModel } from "./types";

const models = [
  { id: "shared", name: "GPT Mini", provider: "openai", thinkingLevels: ["off", "high"] },
  { id: "shared", name: "GPT Mini", provider: "github-copilot", thinkingLevels: ["off", "high"] },
  { id: "haiku", name: "Claude Haiku", provider: "github-copilot", thinkingLevels: ["off"] },
  { id: "custom", name: "Local model", provider: "custom", thinkingLevels: ["off"] },
] satisfies InputModel[];
const providers = [
  { id: "openai", name: "OpenAI" },
  { id: "github-copilot", name: "GitHub Copilot" },
  { id: "anthropic", name: "Anthropic" },
];

test("provider rail groups available models and retains providers without known artwork", () => {
  expect(modelPickerProviders(models, providers)).toEqual([
    { id: "openai", name: "OpenAI" },
    { id: "github-copilot", name: "GitHub Copilot" },
    { id: "custom", name: "custom" },
  ]);
  expect(visiblePickerModels(models, providers, "github-copilot", "")).toEqual(models.slice(1, 3));
  expect(visiblePickerModels(models, providers, null, "")).toEqual(models);
});

test("dynamic Magpie models have a searchable group without changing provider identity", () => {
  const magpieModels: InputModel[] = [
    { id: "shared", name: "Shared", provider: "magpie", thinkingLevels: ["off"] },
    { id: "shared", name: "Shared", provider: "custom", thinkingLevels: ["off"] },
  ];
  const groups = modelPickerProviders(magpieModels, []);
  expect(groups).toEqual([
    { id: "magpie", name: "Magpie" },
    { id: "custom", name: "custom" },
  ]);
  expect(visiblePickerModels(magpieModels, groups, "magpie", "")).toEqual([magpieModels[0]]);
  expect(visiblePickerModels(magpieModels, groups, "custom", "Magpie")).toEqual([magpieModels[0]]);
  expect(modelPickerProviders(magpieModels, [{ id: "magpie", name: "Custom name" }])[0]).toEqual({
    id: "magpie",
    name: "Custom name",
  });
});

test("search spans providers and clearing it restores the active provider", () => {
  expect(visiblePickerModels(models, providers, "openai", "  gPt  ")).toEqual(models.slice(0, 2));
  expect(visiblePickerModels(models, providers, "openai", "GitHub Copilot")).toEqual(
    models.slice(1, 3),
  );
  expect(visiblePickerModels(models, providers, "openai", "Haiku")).toEqual([models[2]]);
  expect(visiblePickerModels(models, providers, "openai", "   ")).toEqual([models[0]]);
  expect(visiblePickerModels(models, providers, null, "missing")).toEqual([]);
});
