import { expect, test } from "vite-plus/test";
import { ModelRecents } from "./model-recents";

test("recent model order survives reopening and scopes identical IDs independently", () => {
  let saved = "";
  const storage = {
    getItem: () => saved || null,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const recents = new ModelRecents(storage);
  const first = {
    scope: "local",
    provider: "constructor",
    modelId: "__proto__",
    thinkingLevel: "off",
  } as const;
  const second = {
    scope: "local",
    provider: "other",
    modelId: "model",
    thinkingLevel: "high",
  } as const;
  const cloud = { ...first, scope: "cloud:https://example.com" };
  recents.record(first);
  recents.record(second);
  recents.record(cloud);
  recents.record({ ...first, thinkingLevel: "high" });
  expect(new ModelRecents(storage).getSnapshot()).toEqual([
    { ...first, thinkingLevel: "high" },
    cloud,
    second,
  ]);
});

test("invalid or unavailable storage does not prevent choices", () => {
  const recents = new ModelRecents({
    getItem: () => "invalid",
    setItem: () => {
      throw new Error("full");
    },
  });
  recents.record({ scope: "local", provider: "p", modelId: "m", thinkingLevel: "off" });
  expect(recents.getSnapshot()).toHaveLength(1);
});
