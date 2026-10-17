import { expect, test } from "vite-plus/test";
import { readRecovery } from "../../../src/service/threads/operations.ts";

type RecoveryRuntime = Parameters<typeof readRecovery>[0];

const nestedInput = {
  kind: "nested",
  parent: "parent-task",
  parentCallId: "parent-call",
  key: "c1",
  call: {
    type: "toolCall",
    id: "parent-call/c1",
    name: "read",
    arguments: { path: "file.txt" },
  },
};

function runtimeFor(
  input: unknown,
  options: { checkpointReplay?: "safe" | "unsafe"; toolReplay?: "safe" | "unsafe" } = {},
): RecoveryRuntime {
  const tasks = [
    {
      record: {
        id: "task-1",
        conversationId: "conversation-1",
        kind: "pi.tool",
        input,
        state: {
          checkpoint: { phase: "execute", replay: options.checkpointReplay ?? "safe" },
        },
      },
      state: { kind: "running" },
    },
  ];
  return {
    harness: {
      inspect: async () => ({ tasks, submissions: [] }),
      conversation: async () => ({
        agent: async () => ({ tools: [{ name: "read", replay: options.toolReplay ?? "safe" }] }),
      }),
    },
    storage: {
      entry: async () => ({
        entry: {
          model: [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "model-call", name: "read", arguments: {} }],
            },
          ],
        },
      }),
    },
    recoveryRequired: true,
    hasWork: async () => true,
  } as unknown as RecoveryRuntime;
}

test("recovery recognizes replay-safe legacy, model, and nested tool inputs", async () => {
  for (const input of [
    { assistant: 1, callId: "model-call" },
    { kind: "model", assistant: 1, callId: "model-call" },
    nestedInput,
  ]) {
    const recovery = await readRecovery(runtimeFor(input));
    expect(recovery.unsafeTool).toBe(false);
  }
});

test("recovery conservatively blocks unsafe, unknown, or malformed nested tool inputs", async () => {
  const unsafePolicy = await readRecovery(runtimeFor(nestedInput, { toolReplay: "unsafe" }));
  expect(unsafePolicy.unsafeTool).toBe(true);

  const unsafeIntent = await readRecovery(runtimeFor(nestedInput, { checkpointReplay: "unsafe" }));
  expect(unsafeIntent.unsafeTool).toBe(true);

  const unknownTool = await readRecovery(
    runtimeFor({ ...nestedInput, call: { ...nestedInput.call, name: "unregistered" } }),
  );
  expect(unknownTool.unsafeTool).toBe(true);

  const malformed = await readRecovery(
    runtimeFor({ ...nestedInput, call: { type: "toolCall", name: "read" } }),
  );
  expect(malformed.unsafeTool).toBe(true);
});

test.each([
  { status: "queued", task: undefined, pending: true, queuedOnly: true },
  { status: "placed", task: undefined, pending: true, queuedOnly: false },
  { status: "queued", task: "pi.generation", pending: true, queuedOnly: false },
  { status: "queued", task: "eta.subagent-reporter", pending: true, queuedOnly: false },
  { status: undefined, task: undefined, pending: false, queuedOnly: false },
] as const)(
  "recovery distinguishes $status submissions with $task work from an idle queue",
  async ({ status, task, pending, queuedOnly }) => {
    const runtime = {
      recoveryRequired: false,
      harness: {
        inspect: async () => ({
          submissions: status ? [{ status }] : [],
          tasks: task ? [{ record: { kind: task }, state: { kind: "running" } }] : [],
        }),
      },
    } as unknown as RecoveryRuntime;
    expect(await readRecovery(runtime)).toMatchObject({ pending, queuedOnly });
  },
);
