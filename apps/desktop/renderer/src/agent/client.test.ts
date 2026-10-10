import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { OperationAdmission } from "@eta/core/agent/protocol";
import type { SessionResponse, SnapshotResponse, ThinkingLevel } from "@eta/core/agent/protocol";
import type { AgentEvent, AgentBridge } from "../../../src/bridge.ts";
import { ThreadAgentClient } from "./client.ts";
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
  submit = async (_sessionId: string, _prompt: string) => admission;
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
