import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { AgentEvent, DesktopBridge } from "./bridge.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionResponse } from "@eta/core/agent/protocol";
import type { ImageAttachment } from "@eta/core/images/types";
import { BotStore } from "../../bot/src/store.ts";
import { ThreadAgentClient } from "../renderer/src/agent/client.ts";
import { DraftThread } from "../renderer/src/agent/draft-thread.ts";

const transport = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
  events: new Set<(event: unknown, payload: unknown) => void>(),
  expose: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: transport.expose },
  ipcRenderer: {
    invoke: transport.invoke,
    send: transport.send,
    on: (_name: string, listener: (event: unknown, payload: unknown) => void) => {
      transport.events.add(listener);
    },
    removeListener: (_name: string, listener: (event: unknown, payload: unknown) => void) => {
      transport.events.delete(listener);
    },
  },
}));
let bridge: DesktopBridge;
beforeEach(async () => {
  vi.resetModules();
  transport.events.clear();
  transport.invoke.mockReset();
  transport.send.mockClear();
  transport.expose.mockClear();
  await import("./preload.ts");
  bridge = transport.expose.mock.calls[0]![1] as DesktopBridge;
});
test("independent subscriptions survive another listener unsubscribing, and ignore old epochs", () => {
  const first: AgentEvent[] = [];
  const second: AgentEvent[] = [];
  const off1 = bridge.subscribe("thread", (event) => first.push(event));
  const off2 = bridge.subscribe("thread", (event) => second.push(event));
  const token1 = transport.send.mock.calls[0]![2];
  const token2 = transport.send.mock.calls[1]![2];
  expect(token1).not.toBe(token2);
  const event: AgentEvent = { type: "error", message: "current event" };
  const emit = (subscriptionId: unknown) => {
    for (const listener of transport.events)
      listener({}, { sessionId: "thread", subscriptionId, event });
  };
  emit(token1);
  expect(first).toEqual([event]);
  expect(second).toEqual([]);
  off1();
  emit(token1);
  emit(token2);
  expect(first).toEqual([event]);
  expect(second).toEqual([event]);
  expect(transport.send.mock.calls.at(-1)).toEqual(["agent:unwatch", token1]);
  off2();
  expect(transport.events.size).toBe(0);
});

test("invoke decodes success values and preserves domain error metadata", async () => {
  transport.invoke.mockResolvedValueOnce({ ok: true, value: { id: "thread" } });
  await expect(bridge.openThread("thread")).resolves.toEqual({ id: "thread" });
  transport.invoke.mockResolvedValueOnce({
    ok: false,
    error: { code: "Busy", message: "Workspace busy", retryable: true },
  });
  await expect(bridge.submit("thread", "Hello")).rejects.toMatchObject({
    code: "Busy",
    retryable: true,
    message: "Workspace busy",
  });
});

test("initial thread reads return the error DTO without throwing across contextBridge", async () => {
  const reply = { ok: false, error: { code: "BotRequestFailed", message: "502", retryable: true } };
  transport.invoke.mockResolvedValueOnce(reply);
  await expect(bridge.openThreadReply!("thread")).resolves.toEqual(reply);
  expect(transport.invoke).toHaveBeenLastCalledWith("eta:command", { type: "open", id: "thread" });
});

const opened: SessionResponse = {
  id: "thread",
  model: {
    provider: "test",
    id: "one",
    name: "One",
    contextWindow: 10000,
    thinkingLevels: ["off"],
  },
  contextTokens: 0,
  snapshot: {
    configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
    transcript: [],
    operation: null,
    lastResult: null,
    faulted: false,
  },
};

test.each([
  { kind: "client", dto: true, definite: false, ipc: "none" },
  { kind: "draft", dto: true, definite: false, ipc: "none" },
  { kind: "client", dto: false, definite: false, ipc: "none" },
  { kind: "draft", dto: false, definite: false, ipc: "none" },
  { kind: "client", dto: true, definite: true, ipc: "none" },
  { kind: "draft", dto: true, definite: true, ipc: "none" },
  { kind: "client", dto: true, definite: false, ipc: "before" },
  { kind: "draft", dto: true, definite: false, ipc: "before" },
  { kind: "client", dto: true, definite: false, ipc: "after" },
  { kind: "draft", dto: true, definite: false, ipc: "after" },
])(
  "$kind submission crosses the reply boundary (DTO=$dto, definite=$definite, IPC=$ipc)",
  async ({ kind, dto, definite, ipc }) => {
    const root = await mkdtemp(join(tmpdir(), "eta-submit-reply-"));
    const store = new BotStore(join(root, "bot.sqlite"));
    const requestIds: string[] = [];
    let executions = 0;
    const admission = { operationId: "run", kind: "run" as const, startedAt: 1 };
    transport.invoke.mockImplementation(
      async (
        _channel: string,
        command: {
          type: string;
          id?: string;
          prompt?: string;
          images?: readonly ImageAttachment[];
          requestId?: string;
        },
      ) => {
        if (command.type === "open" || command.type === "create")
          return { ok: true, value: opened };
        if (command.type !== "submit") throw new Error("Unexpected command");
        const requestId = command.requestId!;
        requestIds.push(requestId);
        if (ipc === "before" && requestIds.length === 1) throw new Error("Controlled failure");
        // A definite rejection never reaches admission; an unknown outcome has already committed.
        const value =
          definite && requestIds.length === 1
            ? undefined
            : await store.request(
                "messages:" + command.id,
                requestId,
                JSON.stringify({ prompt: command.prompt, images: command.images }),
                async () => {
                  executions++;
                  return admission;
                },
              );
        // The receipt is committed, but Electron never delivers a reply DTO.
        if (ipc === "after" && requestIds.length === 1) throw new Error("Controlled failure");
        if (requestIds.length === 1)
          return {
            ok: false,
            error: {
              code: definite ? "Forbidden" : "BotRequestFailed",
              message: "Controlled failure",
              retryable: !definite,
            },
          };
        return { ok: true, value };
      },
    );
    // This models contextBridge's message-only rejected Error, not native Electron itself.
    const legacySubmit = vi.fn(async (...args: Parameters<DesktopBridge["submit"]>) => {
      try {
        return await bridge.submit(...args);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    });
    const renderer = {
      ...bridge,
      submit: legacySubmit,
      submitReply:
        dto && bridge.submitReply
          ? async (...args: Parameters<DesktopBridge["submit"]>) =>
              structuredClone(await bridge.submitReply!(...args))
          : undefined,
    };
    const client = new ThreadAgentClient(renderer);
    const draft = new DraftThread("draft-key", renderer);
    const images = [
      { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png", name: "shot.png" },
    ];
    const send =
      kind === "client"
        ? () => client.submit("Hello", structuredClone(images))
        : () => draft.submit("workspace", "Hello", structuredClone(images));
    try {
      if (kind === "client") await client.connect("thread");
      await expect(send()).rejects.toThrow("Controlled failure");
      expect(requestIds).toHaveLength(1);
      expect(executions).toBe(definite || ipc === "before" ? 0 : 1);
      await send();
      expect(requestIds).toHaveLength(2);
      if (dto && !definite) expect(requestIds[1]).toBe(requestIds[0]);
      else expect(requestIds[1]).not.toBe(requestIds[0]);
      expect(executions).toBe(dto || definite ? 1 : 2);
      expect(legacySubmit).toHaveBeenCalledTimes(dto ? 0 : 2);
      if (kind === "client") {
        const subscriptionId = transport.send.mock.calls.find(
          ([channel]) => channel === "agent:watch",
        )![2];
        for (const listener of transport.events)
          listener(
            {},
            {
              sessionId: "thread",
              subscriptionId,
              event: {
                type: "snapshot",
                value: {
                  snapshot: {
                    ...opened.snapshot,
                    lastResult: {
                      ...admission,
                      endedAt: 2,
                      status: "completed",
                      fromTipId: null,
                      tipId: null,
                    },
                  },
                  contextTokens: 0,
                },
              },
            },
          );
      }
      // Once an attempt succeeds, the next identical message is intentionally new work.
      await send();
      expect(requestIds[2]).not.toBe(requestIds[1]);
      expect(executions).toBe(dto || definite ? 2 : 3);
    } finally {
      client.dispose();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
