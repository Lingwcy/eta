import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { OperationAdmission, OperationResult } from "@eta/core/agent/protocol";
import type { SessionResponse, SnapshotResponse, ThinkingLevel } from "@eta/core/agent/protocol";
import type { AgentEvent, AgentBridge, CommandReply } from "../../../src/bridge.ts";
import { ThreadAgentClient } from "./client.ts";
import { DesktopCommandError } from "../../../src/command-reply.ts";
import type { SandboxMode } from "@eta/core/shared/sandbox";

class TestBridge implements AgentBridge {
  session!: SessionResponse;
  listener?: (event: AgentEvent) => void;
  unsubscribed = 0;
  openThread = async (_id: string) => this.session;
  configureSandbox = async (_id: string, mode: SandboxMode): Promise<SessionResponse> => ({
    ...this.session,
    snapshot: {
      ...this.session.snapshot,
      sandbox: { mode, backend: "seatbelt", available: true },
    },
  });
  configureThread = async (
    _id: string,
    provider: string,
    modelId: string,
    thinkingLevel: ThinkingLevel,
  ) => ({
    ...this.session,
    model: {
      ...this.session.model,
      provider,
      id: modelId,
      name: "Selected model",
      contextWindow: 64000,
    },
    snapshot: {
      ...this.session.snapshot,
      configuration: { model: { provider, modelId }, thinkingLevel },
    },
  });
  submit: AgentBridge["submit"] = async (_sessionId, _prompt) => admission;
  operation = vi.fn(async (_id: string, operationId: string): Promise<OperationResult> => ({
    ...admission,
    operationId,
    status: "running",
    messages: [],
  }));
  stop = async (_sessionId: string) => {};
  subscribe = (_sessionId: string, listener: (event: AgentEvent) => void) => {
    this.listener = listener;
    return () => {
      this.unsubscribed++;
      this.listener = undefined;
    };
  };
  emit(value: SnapshotResponse) {
    this.listener?.({ type: "snapshot", value });
  }
}

let session: SessionResponse;
let bridge: TestBridge;
const clients: ThreadAgentClient[] = [];
const admission: OperationAdmission = { operationId: "admitted-run", kind: "run", startedAt: 1000 };

beforeEach(() => {
  session = {
    id: "test-thread",
    model: {
      provider: "test-provider",
      id: "test-model",
      name: "Test model",
      contextWindow: 64000,
      thinkingLevels: ["off", "low", "high"],
    },
    snapshot: {
      configuration: {
        model: { provider: "test-provider", modelId: "test-model" },
        thinkingLevel: "off",
      },
      transcript: [],
      operation: null,
      lastResult: null,
      faulted: false,
    },
    contextTokens: 0,
  };
  bridge = new TestBridge();
  bridge.session = session;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
});

async function connectedClient() {
  const client = new ThreadAgentClient(bridge);
  clients.push(client);
  await client.connect(session.id);
  return client;
}

test("keeps an admitted prompt busy until the main process acknowledges it", async () => {
  const client = await connectedClient();
  await client.submit("Hello");
  expect(client.getSnapshot().admission?.operationId).toBe(admission.operationId);
  await expect(client.submit("Too soon")).rejects.toThrow("尚未就绪");
  const snapshot = structuredClone(session.snapshot);
  snapshot.operation = {
    id: admission.operationId,
    kind: "run",
    startedAt: admission.startedAt,
    fromTipId: null,
    status: "running",
    runningTools: [],
  };
  bridge.emit({ snapshot, contextTokens: 3 });
  expect(client.getSnapshot().admission).toBeNull();
  expect(client.getSnapshot().observation?.snapshot.operation?.id).toBe(admission.operationId);
  snapshot.operation = null;
  snapshot.lastResult = {
    operationId: admission.operationId,
    kind: "run",
    status: "completed",
    fromTipId: null,
    tipId: null,
    startedAt: 1000,
    endedAt: 2000,
  };
  bridge.emit({ snapshot, contextTokens: 10 });
  expect(client.getSnapshot().observation?.contextTokens).toBe(10);
  await expect(client.submit("Next prompt")).resolves.toBeUndefined();
});

test("does not leave stale admission state when completion arrives before the invoke response", async () => {
  const client = await connectedClient();
  bridge.submit = async () => {
    const snapshot = structuredClone(session.snapshot);
    snapshot.lastResult = {
      operationId: admission.operationId,
      kind: "run",
      status: "completed",
      fromTipId: null,
      tipId: null,
      startedAt: 1000,
      endedAt: 2000,
    };
    bridge.emit({ snapshot, contextTokens: 10 });
    return admission;
  };
  await client.submit("Quick answer");
  expect(client.getSnapshot().admission).toBeNull();
  expect(client.getSnapshot().submitting).toBe(false);
});

function laterObservation(): SnapshotResponse {
  return {
    contextTokens: 42,
    snapshot: {
      ...session.snapshot,
      transcript: [
        {
          id: "later-input",
          type: "message",
          message: { role: "user", content: "Later scheduled turn", timestamp: 3000 },
        },
      ],
      lastResult: {
        operationId: "later-run",
        kind: "run",
        status: "completed",
        startedAt: 3000,
        endedAt: 4000,
        fromTipId: null,
        tipId: null,
      },
    },
  };
}

test.each(["completed", "failed", "aborted"] as const)(
  "reconciles a missed %s receipt without replacing a newer observed turn",
  async (status) => {
    vi.useFakeTimers();
    const client = await connectedClient();
    await client.submit("First input");
    const newer = laterObservation();
    bridge.emit(newer);
    bridge.operation.mockResolvedValue({ ...admission, status, messages: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.operation).toHaveBeenCalledExactlyOnceWith(session.id, admission.operationId);
    expect(client.getSnapshot().admission).toBeNull();
    expect(client.getSnapshot().observation).toBe(newer);
    await expect(client.submit("Next input")).resolves.toBeUndefined();
  },
);

test("reconciles when a late admission reply arrives after a later turn's snapshot", async () => {
  vi.useFakeTimers();
  const client = await connectedClient();
  bridge.submit = async () => {
    bridge.emit(laterObservation());
    return admission;
  };
  bridge.operation.mockResolvedValue({ ...admission, status: "completed", messages: [] });
  await client.submit("First input");
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.getSnapshot().admission).toBeNull();
  expect(client.getSnapshot().observation?.snapshot.lastResult?.operationId).toBe("later-run");
});

test("keeps queued, running and paused receipts locked until their durable terminal result", async () => {
  vi.useFakeTimers();
  const client = await connectedClient();
  await client.submit("First input");
  bridge.emit(laterObservation());
  for (const status of ["queued", "running", "paused"] as const) {
    bridge.operation.mockResolvedValue({ ...admission, status, messages: [] });
    await vi.advanceTimersByTimeAsync(status === "queued" ? 1000 : 2000);
    expect(client.getSnapshot().admission).toBe(admission);
    await expect(client.submit("Too soon")).rejects.toThrow("尚未就绪");
  }
  bridge.operation.mockResolvedValue({ ...admission, status: "completed", messages: [] });
  await vi.advanceTimersByTimeAsync(2000);
  expect(client.getSnapshot().admission).toBeNull();
  expect(bridge.operation).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

test("retries an unavailable receipt without treating a lookup failure as completion", async () => {
  vi.useFakeTimers();
  const client = await connectedClient();
  bridge.operation
    .mockRejectedValueOnce(new Error("Temporary Bot failure"))
    .mockResolvedValue({ ...admission, status: "completed", messages: [] });
  await client.submit("First input");
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.getSnapshot().admission).toBe(admission);
  expect(client.getSnapshot().error).toBeNull();
  await vi.advanceTimersByTimeAsync(2000);
  expect(client.getSnapshot().admission).toBeNull();
});

test("does not poll a receipt already acknowledged by the live snapshot", async () => {
  vi.useFakeTimers();
  const client = await connectedClient();
  await client.submit("First input");
  bridge.emit({
    ...laterObservation(),
    snapshot: {
      ...session.snapshot,
      operation: {
        id: admission.operationId,
        kind: "run",
        startedAt: 1000,
        fromTipId: null,
        status: "running",
        runningTools: [],
      },
    },
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(client.getSnapshot().admission).toBeNull();
  expect(bridge.operation).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("an obsolete receipt lookup cannot clear or restart polling for its replacement", async () => {
  vi.useFakeTimers();
  const client = await connectedClient();
  const pending = Promise.withResolvers<OperationResult>();
  bridge.operation.mockImplementationOnce(() => pending.promise);
  await client.submit("First input");
  await vi.advanceTimersByTimeAsync(1000);
  bridge.emit(laterObservation());
  bridge.emit(laterObservation());
  await vi.advanceTimersByTimeAsync(10000);
  expect(bridge.operation).toHaveBeenCalledTimes(1);
  const firstCompleted = laterObservation();
  firstCompleted.snapshot.lastResult!.operationId = admission.operationId;
  bridge.emit(firstCompleted);
  const replacement = { ...admission, operationId: "replacement-run" };
  bridge.submit = async () => replacement;
  await client.submit("Replacement input");
  pending.resolve({ ...admission, status: "completed", messages: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(client.getSnapshot().admission).toBe(replacement);
  bridge.operation.mockResolvedValue({ ...replacement, status: "running", messages: [] });
  await vi.advanceTimersByTimeAsync(1000);
  expect(bridge.operation).toHaveBeenCalledTimes(2);
  expect(bridge.operation).toHaveBeenLastCalledWith(session.id, replacement.operationId);
  expect(vi.getTimerCount()).toBe(1);
});

test("disposing a view invalidates an in-flight receipt lookup and its retry", async () => {
  vi.useFakeTimers();
  const client = await connectedClient();
  const pending = Promise.withResolvers<OperationResult>();
  bridge.operation.mockImplementationOnce(() => pending.promise);
  await client.submit("First input");
  await vi.advanceTimersByTimeAsync(1000);
  const before = client.getSnapshot();
  client.dispose();
  pending.resolve({ ...admission, status: "completed", messages: [] });
  await vi.advanceTimersByTimeAsync(5000);
  expect(client.getSnapshot()).toBe(before);
  expect(bridge.operation).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a response for another operation cannot acknowledge the pending admission", async () => {
  vi.useFakeTimers();
  const client = await connectedClient();
  bridge.operation.mockResolvedValue({
    ...admission,
    operationId: "wrong-run",
    status: "completed",
    messages: [],
  });
  await client.submit("First input");
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.getSnapshot().admission).toBe(admission);
  expect(vi.getTimerCount()).toBe(1);
});

test("a late open after disposal does not install a subscription", async () => {
  let finish!: (response: SessionResponse) => void;
  bridge.openThread = () => new Promise((resolve) => (finish = resolve));
  const client = new ThreadAgentClient(bridge);
  clients.push(client);
  const connecting = client.connect(session.id);
  client.dispose();
  finish(session);
  await connecting;
  expect(bridge.listener).toBeUndefined();
  expect(client.getSnapshot().session).toBeNull();
});

test("disposal unsubscribes only once", async () => {
  const client = await connectedClient();
  client.dispose();
  client.dispose();
  expect(bridge.unsubscribed).toBe(1);
});

test("reports subscription errors from the main process", async () => {
  const client = await connectedClient();
  bridge.listener?.({ type: "error", message: "会话不存在" });
  expect(client.getSnapshot().connection).toBe("error");
  expect(client.getSnapshot().error).toBe("会话不存在");
});

test("a rejected prompt reports an error and releases the submission lock", async () => {
  const client = await connectedClient();
  bridge.submit = vi.fn(async () => {
    throw new Error("Lane busy");
  });
  await expect(client.submit("Not admitted")).rejects.toThrow("Lane busy");
  expect(client.getSnapshot()).toMatchObject({
    admission: null,
    submitting: false,
    error: "Lane busy",
  });
});

test("changing models keeps the transcript visible and retains the live subscription", async () => {
  const client = await connectedClient();
  const transcript: SessionResponse["snapshot"]["transcript"] = [
    {
      id: "saved-message",
      type: "message",
      message: { role: "user", content: "Existing context", timestamp: 1 },
    },
  ];
  bridge.emit({ snapshot: { ...session.snapshot, transcript }, contextTokens: 42 });
  const rendered = [] as ReturnType<ThreadAgentClient["getSnapshot"]>[];
  client.subscribe(() => rendered.push(client.getSnapshot()));
  const listener = bridge.listener;
  await client.configure("other-provider", "other-model", "high");
  expect(client.getSnapshot().session?.model).toMatchObject({
    provider: "other-provider",
    id: "other-model",
    name: "Selected model",
    contextWindow: 64000,
  });
  expect(client.getSnapshot().observation?.snapshot.configuration).toEqual({
    model: { provider: "other-provider", modelId: "other-model" },
    thinkingLevel: "high",
  });
  expect(rendered.length).toBeGreaterThan(0);
  for (const state of rendered) {
    expect(state.connection).toBe("connected");
    expect(state.observation?.snapshot.transcript).toBe(transcript);
    expect(state.observation?.contextTokens).toBe(42);
  }
  expect(bridge.listener).toBe(listener);
  expect(bridge.unsubscribed).toBe(0);
  bridge.emit({
    snapshot: {
      ...client.getSnapshot().observation!.snapshot,
      transcript: [
        ...transcript,
        {
          id: "later-message",
          type: "message",
          message: { role: "user", content: "Next message", timestamp: 2 },
        },
      ],
    },
    contextTokens: 50,
  });
  expect(client.getSnapshot().observation?.snapshot.transcript).toHaveLength(2);
});

test("sandbox changes keep the transcript visible and retain the live subscription", async () => {
  const client = await connectedClient();
  const transcript: SessionResponse["snapshot"]["transcript"] = [
    {
      id: "existing-message",
      type: "message",
      message: { role: "user", content: "Keep this history", timestamp: 1 },
    },
  ];
  bridge.emit({ snapshot: { ...session.snapshot, transcript }, contextTokens: 42 });
  const rendered: ReturnType<ThreadAgentClient["getSnapshot"]>[] = [];
  client.subscribe(() => rendered.push(client.getSnapshot()));
  const listener = bridge.listener;
  await client.configureSandbox("read-only");
  expect(client.getSnapshot().observation?.snapshot.sandbox?.mode).toBe("read-only");
  expect(rendered.length).toBeGreaterThan(0);
  for (const state of rendered) {
    expect(state.connection).toBe("connected");
    expect(state.observation?.snapshot.transcript).toBe(transcript);
    expect(state.observation?.contextTokens).toBe(42);
  }
  expect(bridge.listener).toBe(listener);
  expect(bridge.unsubscribed).toBe(0);
  bridge.emit({ snapshot: { ...session.snapshot, transcript }, contextTokens: 50 });
  expect(client.getSnapshot().observation?.contextTokens).toBe(50);
});

test("a late sandbox reply preserves newer transcript, operation and context updates", async () => {
  const client = await connectedClient();
  const configured = await bridge.configureSandbox(session.id, "read-only");
  let finish!: (value: SessionResponse) => void;
  bridge.configureSandbox = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = client.configureSandbox("read-only");
  const newer: SnapshotResponse = {
    contextTokens: 100,
    snapshot: {
      ...configured.snapshot,
      transcript: [
        {
          id: "newer",
          type: "message",
          message: { role: "user", content: "Newer context", timestamp: 2 },
        },
      ],
      operation: {
        ...admission,
        id: admission.operationId,
        status: "running",
        fromTipId: null,
        runningTools: [],
        streamingMessage: fauxAssistantMessage("Keep streaming"),
      },
    },
  };
  bridge.emit(newer);
  finish(configured);
  await pending;
  expect(client.getSnapshot().observation?.snapshot.transcript).toBe(newer.snapshot.transcript);
  expect(client.getSnapshot().observation?.snapshot.operation).toBe(newer.snapshot.operation);
  expect(client.getSnapshot().observation?.contextTokens).toBe(100);
});

test("a failed sandbox change preserves the previous policy, history and connection", async () => {
  const client = await connectedClient();
  const before = client.getSnapshot();
  bridge.configureSandbox = async () => {
    throw new Error("Sandbox unavailable");
  };
  await expect(client.configureSandbox("read-only")).rejects.toThrow("Sandbox unavailable");
  expect(client.getSnapshot()).toBe(before);
  expect(bridge.unsubscribed).toBe(0);
});

test("a sandbox reply after leaving the thread cannot update the disposed view", async () => {
  const client = await connectedClient();
  const before = client.getSnapshot();
  const configured = await bridge.configureSandbox(session.id, "read-only");
  let finish!: (value: SessionResponse) => void;
  bridge.configureSandbox = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = client.configureSandbox("read-only");
  client.dispose();
  finish(configured);
  await pending;
  expect(client.getSnapshot()).toBe(before);
});

test("a late configuration reply preserves newer transcript, operation and context updates", async () => {
  const client = await connectedClient();
  const configured = await bridge.configureThread(session.id, "provider", "model", "high");
  let finish!: (value: SessionResponse) => void;
  bridge.configureThread = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = client.configure("provider", "model", "high");
  const newer: SnapshotResponse = {
    contextTokens: 100,
    snapshot: {
      ...configured.snapshot,
      transcript: [
        {
          id: "newer",
          type: "message",
          message: { role: "user", content: "Newer context", timestamp: 2 },
        },
      ],
      operation: {
        ...admission,
        id: admission.operationId,
        status: "running",
        fromTipId: null,
        runningTools: [],
      },
    },
  };
  bridge.emit(newer);
  finish(configured);
  await pending;
  expect(client.getSnapshot().observation?.snapshot.transcript).toBe(newer.snapshot.transcript);
  expect(client.getSnapshot().observation?.snapshot.operation).toBe(newer.snapshot.operation);
  expect(client.getSnapshot().observation?.contextTokens).toBe(100);
});

test("a rejected model change leaves the current model, history and connection intact", async () => {
  const client = await connectedClient();
  const before = client.getSnapshot();
  bridge.configureThread = async () => {
    throw new Error("Model unavailable");
  };
  await expect(client.configure("missing", "model", "high")).rejects.toThrow("Model unavailable");
  expect(client.getSnapshot()).toBe(before);
  expect(bridge.unsubscribed).toBe(0);
});

test("a configuration reply after leaving the thread cannot update the disposed view", async () => {
  const client = await connectedClient();
  const before = client.getSnapshot();
  const configured = await bridge.configureThread(session.id, "provider", "model", "high");
  let finish!: (value: SessionResponse) => void;
  bridge.configureThread = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = client.configure("provider", "model", "high");
  client.dispose();
  finish(configured);
  await pending;
  expect(client.getSnapshot()).toBe(before);
});

function openingClient() {
  const openThreadReply = vi.fn<NonNullable<AgentBridge["openThreadReply"]>>();
  const client = new ThreadAgentClient({ ...bridge, openThreadReply });
  clients.push(client);
  return { client, openThreadReply };
}

const unavailable = {
  ok: false,
  error: { code: "BotRequestFailed", message: "Bot 请求失败 (502)", retryable: true },
} satisfies CommandReply<SessionResponse>;

test("a recoverable initial read retries then installs exactly one live subscription", async () => {
  vi.useFakeTimers();
  const { client, openThreadReply } = openingClient();
  openThreadReply
    .mockResolvedValueOnce(unavailable)
    .mockResolvedValue({ ok: true, value: session });
  const connecting = client.connect(session.id);
  await vi.advanceTimersByTimeAsync(999);
  expect(openThreadReply).toHaveBeenCalledTimes(1);
  expect(client.getSnapshot().connection).toBe("connecting");
  expect(bridge.listener).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await connecting;
  expect(openThreadReply).toHaveBeenCalledTimes(2);
  expect(client.getSnapshot()).toMatchObject({ connection: "connected", error: null });
  expect(client.getSnapshot().observation?.snapshot).toBe(session.snapshot);
  expect(bridge.listener).toBeDefined();
  client.dispose();
  expect(bridge.unsubscribed).toBe(1);
});

test("initial read retries are bounded, while manual retry gets a fresh budget", async () => {
  vi.useFakeTimers();
  const { client, openThreadReply } = openingClient();
  openThreadReply.mockResolvedValue(unavailable);
  const connecting = client.connect(session.id);
  await vi.runAllTimersAsync();
  await connecting;
  expect(openThreadReply).toHaveBeenCalledTimes(3);
  expect(client.getSnapshot()).toMatchObject({
    connection: "error",
    error: unavailable.error.message,
  });
  expect(bridge.listener).toBeUndefined();
  openThreadReply.mockResolvedValueOnce({ ok: true, value: session });
  await client.connect(session.id);
  expect(client.getSnapshot()).toMatchObject({ connection: "connected", error: null });
  expect(openThreadReply).toHaveBeenCalledTimes(4);
});

test.each(["Unauthorized", "Forbidden", "NotFound", "InternalError"])(
  "an initial %s error is not retried",
  async (code) => {
    vi.useFakeTimers();
    const { client, openThreadReply } = openingClient();
    openThreadReply.mockResolvedValue({
      ok: false,
      error: { code, message: code, retryable: false },
    });
    await client.connect(session.id);
    await vi.runAllTimersAsync();
    expect(openThreadReply).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().connection).toBe("error");
    expect(client.getSnapshot().error).toEqual(
      code === "NotFound" ? { key: "errors:NotFound", diagnostic: code } : code,
    );
    expect(bridge.listener).toBeUndefined();
  },
);

test("disposing during retry backoff cancels the retry and settles connect", async () => {
  vi.useFakeTimers();
  const { client, openThreadReply } = openingClient();
  openThreadReply.mockResolvedValue(unavailable);
  const connecting = client.connect(session.id);
  await vi.advanceTimersByTimeAsync(0);
  client.dispose();
  await connecting;
  expect(vi.getTimerCount()).toBe(0);
  await vi.runAllTimersAsync();
  expect(openThreadReply).toHaveBeenCalledTimes(1);
  expect(bridge.listener).toBeUndefined();
});

test.each([true, false])(
  "a late initial read cannot replace a newer connection (success=%s)",
  async (success) => {
    const { client, openThreadReply } = openingClient();
    const old = Promise.withResolvers<CommandReply<SessionResponse>>();
    const replacement = { ...session, id: "replacement" };
    openThreadReply
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ ok: true, value: replacement });
    const connecting = client.connect(session.id);
    await client.connect(replacement.id);
    const listener = bridge.listener;
    old.resolve(success ? { ok: true, value: session } : unavailable);
    await connecting;
    expect(client.getSnapshot()).toMatchObject({
      session: { id: replacement.id },
      connection: "connected",
      error: null,
    });
    expect(bridge.listener).toBe(listener);
    expect(openThreadReply).toHaveBeenCalledTimes(2);
    expect(bridge.unsubscribed).toBe(0);
  },
);

test("a replacement connect cancels pending retry backoff", async () => {
  vi.useFakeTimers();
  const { client, openThreadReply } = openingClient();
  openThreadReply
    .mockResolvedValueOnce(unavailable)
    .mockResolvedValue({ ok: true, value: session });
  const old = client.connect(session.id);
  await vi.advanceTimersByTimeAsync(0);
  await client.connect(session.id);
  await old;
  expect(vi.getTimerCount()).toBe(0);
  await vi.runAllTimersAsync();
  expect(openThreadReply).toHaveBeenCalledTimes(2);
  expect(client.getSnapshot()).toMatchObject({ connection: "connected", error: null });
});

test("a replacement connection ignores old stream callbacks", async () => {
  const client = await connectedClient();
  const stale = bridge.listener;
  await client.connect(session.id);
  stale?.({ type: "error", message: "obsolete failure" });
  stale?.({
    type: "snapshot",
    value: { snapshot: { ...session.snapshot, faulted: true }, contextTokens: 99 },
  });
  expect(client.getSnapshot()).toMatchObject({ connection: "connected", error: null });
  expect(client.getSnapshot().observation?.snapshot.faulted).toBe(false);
  expect(client.getSnapshot().observation?.contextTokens).toBe(0);
  expect(bridge.unsubscribed).toBe(1);
});

test("disposing an in-flight failed read does not schedule a retry", async () => {
  vi.useFakeTimers();
  const { client, openThreadReply } = openingClient();
  const pending = Promise.withResolvers<CommandReply<SessionResponse>>();
  openThreadReply.mockReturnValue(pending.promise);
  const connecting = client.connect(session.id);
  client.dispose();
  pending.resolve(unavailable);
  await connecting;
  expect(vi.getTimerCount()).toBe(0);
  expect(openThreadReply).toHaveBeenCalledTimes(1);
  expect(bridge.listener).toBeUndefined();
});

test("a synchronous subscription that disposes the client releases its returned listener", async () => {
  const unsubscribe = vi.fn();
  bridge.subscribe = () => {
    client.dispose();
    return unsubscribe;
  };
  const client = new ThreadAgentClient(bridge);
  clients.push(client);
  await client.connect(session.id);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  client.dispose();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("a retryable transport failure keeps one request identity for the same message", async () => {
  const client = await connectedClient();
  const calls: (string | undefined)[] = [];
  bridge.submit = vi.fn(
    async (_id: string, _prompt: string, _images?: unknown, requestId?: string) => {
      calls.push(requestId);
      if (calls.length === 1)
        throw new DesktopCommandError({
          code: "BotRequestFailed",
          message: "Request timed out",
          retryable: true,
        });
      return admission;
    },
  );
  await expect(client.submit("Hello")).rejects.toThrow("Request timed out");
  await expect(client.submit("Hello")).resolves.toBeUndefined();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toBeTruthy();
  expect(calls[1]).toBe(calls[0]);
});

test("a new message or a definite rejection never reuses a request identity", async () => {
  const client = await connectedClient();
  const calls: (string | undefined)[] = [];
  bridge.submit = vi.fn(
    async (_id: string, _prompt: string, _images?: unknown, requestId?: string) => {
      calls.push(requestId);
      if (calls.length === 1)
        throw new DesktopCommandError({ code: "Busy", message: "Please wait", retryable: false });
      return admission;
    },
  );
  await expect(client.submit("Hello")).rejects.toThrow("Please wait");
  await expect(client.submit("Hello")).resolves.toBeUndefined();
  expect(calls[1]).not.toBe(calls[0]);

  const other = await connectedClient();
  const retry: (string | undefined)[] = [];
  bridge.submit = vi.fn(
    async (_id: string, _prompt: string, _images?: unknown, requestId?: string) => {
      retry.push(requestId);
      if (retry.length === 1)
        throw new DesktopCommandError({
          code: "BotRequestFailed",
          message: "Request timed out",
          retryable: true,
        });
      return admission;
    },
  );
  await expect(other.submit("Hello")).rejects.toThrow("Request timed out");
  await expect(other.submit("Different text")).resolves.toBeUndefined();
  expect(retry[1]).not.toBe(retry[0]);
});

test("a completed message releases its identity before the next identical send", async () => {
  const client = await connectedClient();
  const calls: (string | undefined)[] = [];
  bridge.submit = vi.fn(
    async (_id: string, _prompt: string, _images?: unknown, requestId?: string) => {
      calls.push(requestId);
      return admission;
    },
  );
  await expect(client.submit("Repeat me")).resolves.toBeUndefined();
  const snapshot = structuredClone(session.snapshot);
  snapshot.lastResult = {
    operationId: admission.operationId,
    kind: "run",
    status: "completed",
    fromTipId: null,
    tipId: null,
    startedAt: 1000,
    endedAt: 2000,
  };
  bridge.emit({ snapshot, contextTokens: 5 });
  expect(client.getSnapshot().admission).toBeNull();
  await expect(client.submit("Repeat me")).resolves.toBeUndefined();
  expect(calls[1]).not.toBe(calls[0]);
});

test("explicit queue admissions do not occupy the singleton execution acknowledgement slot", async () => {
  session.snapshot.inputQueueSupported = true;
  session.snapshot.operation = {
    ...admission,
    id: "root",
    status: "running",
    fromTipId: null,
    runningTools: [],
  };
  let count = 0;
  const send = vi.fn<AgentBridge["submit"]>(async () => ({
    ...admission,
    operationId: "queued-" + ++count,
    status: "queued",
  }));
  bridge.submit = send;
  const client = await connectedClient();
  await client.submit("first", undefined, "followUp");
  expect(client.getSnapshot().submitting).toBe(false);
  expect(client.getSnapshot().admission).toBeNull();
  await client.submit("second", undefined, "steer");
  expect(send.mock.calls.map((call) => call[4])).toEqual(["followUp", "steer"]);
  const snapshot = structuredClone(session.snapshot);
  snapshot.operation = null;
  snapshot.lastResult = {
    ...admission,
    operationId: "queued-2",
    status: "completed",
    fromTipId: null,
    tipId: null,
    endedAt: 2000,
  };
  bridge.emit({ snapshot, contextTokens: 0 });
  expect(client.getSnapshot().admission).toBeNull();
  await expect(client.submit("third", undefined, "steer")).resolves.toBeUndefined();
});

test("an older Bot without input-queue support never receives a mode it cannot honor", async () => {
  const client = await connectedClient();
  const send = vi.fn(bridge.submit);
  bridge.submit = send;
  await expect(client.submit("do not downgrade", undefined, "followUp")).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

test("an unknown queue submission preserves its request ID and includes mode in retry identity", async () => {
  session.snapshot.inputQueueSupported = true;
  const client = await connectedClient();
  const send = vi.fn<AgentBridge["submit"]>(async () => {
    throw new DesktopCommandError({
      code: "SubmissionUnknown",
      message: "No reply",
      retryable: true,
    });
  });
  bridge.submit = send;
  await expect(client.submit("same", undefined, "steer")).rejects.toThrow("No reply");
  await expect(client.submit("same", undefined, "steer")).rejects.toThrow("No reply");
  expect(send.mock.calls[0]![3]).toBe(send.mock.calls[1]![3]);
  await expect(client.submit("same", undefined, "followUp")).rejects.toThrow("No reply");
  expect(send.mock.calls[2]![3]).not.toBe(send.mock.calls[0]![3]);
});

test("refreshing the same view while a submission is pending still settles its transport state", async () => {
  session.snapshot.inputQueueSupported = true;
  const held = Promise.withResolvers<OperationAdmission>();
  bridge.submit = () => held.promise;
  const client = await connectedClient();
  const sending = client.submit("same view", undefined, "steer");
  try {
    await client.connect(session.id);
    held.resolve({ ...admission, status: "queued" });
    await sending;
    expect(client.getSnapshot().submitting).toBe(false);
  } finally {
    held.resolve(admission);
    await sending;
  }
});

test("a late submission reply cannot overwrite a replacement view or clear its pending send", async () => {
  const held = Promise.withResolvers<OperationAdmission>();
  const next = Promise.withResolvers<OperationAdmission>();
  bridge.submit = (_id, prompt) => (prompt === "old" ? held.promise : next.promise);
  const client = await connectedClient();
  const old = client.submit("old");
  let replacement: Promise<void> | undefined;
  try {
    bridge.session = { ...session, id: "replacement" };
    await client.connect("replacement");
    replacement = client.submit("replacement");
    held.resolve(admission);
    await old;
    expect(client.getSnapshot().session?.id).toBe("replacement");
    expect(client.getSnapshot().submitting).toBe(true);
    expect(client.getSnapshot().admission).toBeNull();
    next.resolve({ ...admission, operationId: "replacement-run" });
    await replacement;
    expect(client.getSnapshot().admission?.operationId).toBe("replacement-run");
  } finally {
    held.resolve(admission);
    next.resolve(admission);
    await Promise.all([old, replacement]);
  }
});
