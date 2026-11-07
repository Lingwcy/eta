// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { ModelRecents } from "./model-recents";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

test("stale model stores preserve sequential choices from other contexts after reopening", () => {
  const first = new ModelRecents(localStorage);
  const second = new ModelRecents(localStorage);
  const local = {
    scope: "local",
    provider: "constructor",
    modelId: "__proto__",
    thinkingLevel: "off",
  } as const;
  const cloud = { ...local, scope: "cloud:https://example.com", thinkingLevel: "high" } as const;
  first.record(local);
  second.record(cloud);
  expect(new ModelRecents(localStorage).getSnapshot()).toEqual([cloud, local]);
  const updated = { ...local, thinkingLevel: "low" } as const;
  first.record(updated);
  expect(new ModelRecents(localStorage).getSnapshot()).toEqual([updated, cloud]);
  const other = { ...local, provider: "other" };
  second.record(other);
  expect(new ModelRecents(localStorage).getSnapshot()).toEqual([other, updated, cloud]);
});

test("merging stale model stores keeps the latest 100 distinct persisted choices", () => {
  const stores = [new ModelRecents(localStorage), new ModelRecents(localStorage)];
  for (let i = 0; i < 105; i++)
    stores[i % stores.length]!.record({
      scope: "local",
      provider: "p",
      modelId: String(i),
      thinkingLevel: "off",
    });
  const restored = new ModelRecents(localStorage).getSnapshot();
  expect(restored.map((entry) => entry.modelId)).toEqual(
    Array.from({ length: 100 }, (_, i) => String(104 - i)),
  );
});
