import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { expect, test } from "vite-plus/test";
import { computerParameters } from "../../src/computer/schema.ts";

test("computer input rejects fractional integer fields rather than changing the requested action", () => {
  const tool = { name: "computer", description: "Computer", parameters: computerParameters };
  const validate = (args: Record<string, string | number>) =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "call",
      name: "computer",
      arguments: args,
    });
  expect(() => validate({ action: "click", frameId: "frame", elementIndex: 2 })).not.toThrow();
  expect(() => validate({ action: "click", frameId: "frame", elementIndex: 2.5 })).toThrow();
  expect(() => validate({ action: "scroll", frameId: "frame", deltaY: 1.5 })).toThrow();
});
