import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { OperationAdmission } from "@eta/agent";
import { MemoryHarnessService } from "../../../src/agent/memory-harness.ts";
import type { SessionResponse, SnapshotResponse } from "../../../src/agent/protocol.ts";
import type { AgentEvent, DesktopBridge } from "../../../src/bridge.ts";
import { MemoryAgentClient } from "./client.ts";

class TestBridge implements DesktopBridge {
  session!: SessionResponse;
  listener?: (event: AgentEvent) => void;
  deleted: string[] = [];
  unsubscribed = 0;
  createSession = async () => this.session;
  submit = async (_sessionId: string, _prompt: string) => admission;
  stop = async (_sessionId: string) => {};
  deleteSession = async (sessionId: string) => {
    this.deleted.push(sessionId);
  };
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

let service: MemoryHarnessService;
let session: SessionResponse;
let bridge: TestBridge;
const clients: MemoryAgentClient[] = [];
const admission: OperationAdmission = { operationId: "admitted-run", kind: "run", startedAt: 1000 };

beforeEach(async () => {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  service = new MemoryHarnessService(models, process.cwd());
  session = await service.create();
  bridge = new TestBridge();
  bridge.session = session;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  await service.close();
});

async function connectedClient() {
  const client = new MemoryAgentClient(bridge);
  clients.push(client);
  await client.connect();
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

test("releases a session created after the client has already been disposed", async () => {
  let finish!: (response: SessionResponse) => void;
  bridge.createSession = () => new Promise((resolve) => (finish = resolve));
  const client = new MemoryAgentClient(bridge);
  clients.push(client);
  const connecting = client.connect();
  client.dispose();
  finish(session);
  await connecting;
  expect(bridge.deleted).toEqual([session.id]);
  expect(client.getSnapshot().session).toBeNull();
});

test("unsubscribes and deletes its session only once on disposal", async () => {
  const client = await connectedClient();
  client.dispose();
  client.dispose();
  expect(bridge.unsubscribed).toBe(1);
  expect(bridge.deleted).toEqual([session.id]);
});

test("reports a missing memory session and asks for a new one", async () => {
  const client = await connectedClient();
  bridge.listener?.({ type: "error", message: "内存会话已不存在，请新建会话。" });
  expect(client.getSnapshot().connection).toBe("error");
  expect(client.getSnapshot().error).toContain("新建会话");
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
