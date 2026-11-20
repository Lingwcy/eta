import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { TOOL_INTENT, toolIntents } from "@eta/agent/tools";
import { ROOT_CONVERSATION_ID } from "@eta/agent";
import { expect, test, vi } from "vite-plus/test";
import { createComputerExtension } from "../../src/computer/extension.ts";
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
  expect(() =>
    validate({
      description: "Click the submit button",
      action: "click",
      frameId: "frame",
      elementIndex: 2,
    }),
  ).not.toThrow();
  expect(() => validate({ action: "click", frameId: "frame", elementIndex: 2.5 })).toThrow();
  expect(() => validate({ action: "scroll", frameId: "frame", deltaY: 1.5 })).toThrow();
});

test("computer opts into toolIntents and accepts description during execution", async () => {
  expect(Reflect.get(computerParameters, TOOL_INTENT)).toBe(true);
  const release = vi.fn(async () => {});
  const extension = createComputerExtension({
    service: { release } as never,
    owner: async () => ({ threadId: "t1", scope: "desktop" }) as never,
    allowed: async () => true,
  });
  const tool = extension.tools![0]!;
  const result = await tool.execute(
    { description: "Release desktop control", action: "release" },
    { conversationId: ROOT_CONVERSATION_ID } as never,
    {} as never,
  );
  expect(result.isError).toBeUndefined();
  expect(release).toHaveBeenCalledTimes(1);

  const intents = toolIntents([
    {
      role: "system",
      content: "",
      timestamp: 1,
      toolsAdded: [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-computer",
          name: "computer",
          arguments: { description: "Check game menu screenshot", action: "screenshot" },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
  ]);
  expect(intents).toEqual({ "call-computer": "Check game menu screenshot" });
});
