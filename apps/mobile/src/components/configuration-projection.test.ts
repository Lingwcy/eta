import { expect, test } from "vite-plus/test";
import { applySelection } from "./configuration-projection.ts";

const opened = {
  provider: "p",
  modelId: "one",
  thinkingLevel: "off" as const,
  sandboxMode: "read-only" as const,
};

test("fields the sheet never touched follow the live configuration", () => {
  const latest = {
    ...opened,
    modelId: "two",
    thinkingLevel: "high" as const,
    sandboxMode: "workspace-write" as const,
  };
  expect(applySelection(opened, { ...opened, sandboxMode: "workspace-write" }, latest)).toEqual({
    ...latest,
    sandboxMode: "workspace-write",
  });
  expect(applySelection(opened, opened, latest)).toEqual(latest);
});

test("a chosen model wins and carries its thinking level", () => {
  const latest = {
    ...opened,
    sandboxMode: "workspace-write" as const,
    thinkingLevel: "high" as const,
  };
  const selected = { ...opened, modelId: "two", thinkingLevel: "low" as const };
  expect(applySelection(opened, selected, latest)).toEqual({
    provider: "p",
    modelId: "two",
    thinkingLevel: "low",
    sandboxMode: "workspace-write",
  });
});

test("a changed thinking level without a model change is still written", () => {
  const latest = { ...opened, thinkingLevel: "high" as const };
  expect(applySelection(opened, { ...opened, thinkingLevel: "low" }, latest)).toEqual({
    ...latest,
    thinkingLevel: "low",
  });
});

test("an absent live sandbox keeps an untouched sandbox absent", () => {
  const openedNoSandbox = { provider: "p", modelId: "one", thinkingLevel: "off" as const };
  expect(applySelection(openedNoSandbox, openedNoSandbox, openedNoSandbox)).toEqual(
    openedNoSandbox,
  );
});
