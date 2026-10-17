import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage, fauxToolCall, type Message, Type } from "@earendil-works/pi-ai";
import { toolIntents } from "@eta/agent/tools";

const TOOL_INTENT = "x-eta-tool-intent";

test("a later annotated call replaces its earlier summary without removing other IDs", () => {
  const parameters = Type.Object(
    { description: Type.Optional(Type.String()) },
    { [TOOL_INTENT]: true },
  );
  const messages: Message[] = [
    {
      role: "system",
      content: "",
      timestamp: 1,
      toolsAdded: [{ name: "example", description: "example", parameters }],
    },
    fauxAssistantMessage([
      fauxToolCall("example", { description: "Other action" }, { id: "other" }),
      fauxToolCall("example", { description: "Earlier action" }, { id: "reused" }),
    ]),
  ];
  const streaming = fauxAssistantMessage(
    fauxToolCall("example", { description: "Latest action" }, { id: "reused" }),
  );
  expect(toolIntents(messages, streaming)).toEqual({
    other: "Other action",
    reused: "Latest action",
  });
});

test.each(["unmarked", "removed", "empty", "invalid", "streaming"])(
  "a reused call ID does not inherit an earlier summary (%s)",
  (mode) => {
    const annotated = Type.Object(
      { description: Type.Optional(Type.String()) },
      { [TOOL_INTENT]: true },
    );
    const messages: Message[] = [
      {
        role: "system",
        content: "",
        timestamp: 1,
        toolsAdded: [{ name: "example", description: "example", parameters: annotated }],
      },
      fauxAssistantMessage(
        fauxToolCall("example", { description: "Earlier action" }, { id: "reused" }),
      ),
    ];
    if (mode === "unmarked")
      messages.push({
        role: "system",
        content: "",
        timestamp: 2,
        toolsAdded: [
          {
            name: "example",
            description: "business",
            parameters: Type.Object({ description: Type.String() }),
          },
        ],
      });
    if (mode === "removed")
      messages.push({
        role: "system",
        content: "",
        timestamp: 2,
        toolsRemoved: [{ name: "example" }],
      });
    const latest = fauxAssistantMessage(
      fauxToolCall(
        "example",
        mode === "streaming"
          ? {}
          : {
              description: mode === "invalid" ? 1 : mode === "empty" ? " " : "Business description",
            },
        { id: "reused" },
      ),
    );
    const intents =
      mode === "streaming" ? toolIntents(messages, latest) : toolIntents([...messages, latest]);
    expect(intents).toEqual({});
  },
);
