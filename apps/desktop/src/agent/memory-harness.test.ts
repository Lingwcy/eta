import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { SnapshotResponse } from "./protocol.ts";
import { getTools } from "../../renderer/src/agent/selectors.ts";
import { MemoryHarnessService } from "./memory-harness.ts";
import { readAgentSettings } from "./agent-settings.ts";

const services: MemoryHarnessService[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function setup(
  options: Parameters<typeof fauxProvider>[0] = {},
  readSettings?: ConstructorParameters<typeof MemoryHarnessService>[2],
) {
  const provider = fauxProvider({
    provider: "eta-test",
    models: [{ id: "first-available", name: "Available model" }, { id: "second-available" }],
    tokenSize: { min: 2, max: 2 },
    tokensPerSecond: 1000,
    ...options,
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const service = new MemoryHarnessService(models, process.cwd(), readSettings);
  services.push(service);
  return { provider, models, service };
}

test("uses the first available model and creates isolated memory sessions", async () => {
  const { service, models } = setup();
  const available = await models.getAvailable();
  const first = await service.create();
  const second = await service.create();
  expect(first.model.id).toBe(available[0]!.id);
  expect(first.snapshot.configuration.model).toEqual({
    provider: first.model.provider,
    modelId: first.model.id,
  });
  expect(first.snapshot.transcript).toEqual([]);
  expect(first.contextTokens).toBe(0);
  expect(first.id).not.toBe(second.id);
  await service.get(first.id).conversation.submit(
    {
      type: "write",
      entry: {
        kind: "pi.user",
        model: [{ role: "user", content: "Only the first session", timestamp: Date.now() }],
      },
    },
    BACKGROUND_CONTEXT,
  );
  expect((await service.snapshot(second.id)).snapshot.transcript).toEqual([]);
});

test("does not fall back to a fake or unauthenticated model", async () => {
  const service = new MemoryHarnessService(createModels(), process.cwd());
  services.push(service);
  await expect(service.create()).rejects.toThrow("没有可用模型");
});

test("reads pi defaults for new sessions while preserving existing sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-settings-"));
  directories.push(directory);
  const path = join(directory, "settings.json");
  const { service, models } = setup({}, () => readAgentSettings(path));
  models.setProvider(
    fauxProvider({
      provider: "opencode-go",
      models: [{ id: "deepseek-v4-flash", reasoning: true }],
    }).provider,
  );
  await writeFile(
    path,
    JSON.stringify({
      defaultProvider: "opencode-go",
      defaultModel: "deepseek-v4-flash",
      defaultThinkingLevel: "high",
      unrelatedSetting: true,
    }),
  );
  const first = await service.create();
  expect(first.snapshot.configuration).toMatchObject({
    model: { provider: "opencode-go", modelId: "deepseek-v4-flash" },
    thinkingLevel: "high",
  });
  await writeFile(
    path,
    JSON.stringify({
      defaultProvider: "eta-test",
      defaultModel: "second-available",
      defaultThinkingLevel: "off",
    }),
  );
  const second = await service.create();
  expect(second.model.id).toBe("second-available");
  expect(second.snapshot.configuration.thinkingLevel).toBe("off");
  expect((await service.snapshot(first.id)).snapshot.configuration).toEqual(
    first.snapshot.configuration,
  );
});

test("missing settings retain the available-model fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-settings-"));
  directories.push(directory);
  const { service } = setup({}, () => readAgentSettings(join(directory, "settings.json")));
  const session = await service.create();
  expect(session.model.id).toBe("first-available");
  expect(session.snapshot.configuration.thinkingLevel).toBe("off");
});

test("an unavailable configured model never silently selects another model", async () => {
  const { service } = setup({}, async () => ({
    defaultProvider: "opencode-go",
    defaultModel: "deepseek-v4-flash",
  }));
  await expect(service.create()).rejects.toThrow("opencode-go/deepseek-v4-flash");
});

test.each([
  ["{", "有效的 JSON"],
  ["[]", "JSON 对象"],
  ['{"defaultProvider": ""}', "defaultProvider"],
  ['{"defaultModel": 42}', "defaultModel"],
  ['{"defaultThinkingLevel": "unknown"}', "defaultThinkingLevel"],
])("invalid settings %s prevent session creation with a useful error", async (content, error) => {
  const directory = await mkdtemp(join(tmpdir(), "eta-settings-"));
  directories.push(directory);
  const path = join(directory, "settings.json");
  await writeFile(path, content);
  const { service } = setup({}, () => readAgentSettings(path));
  await expect(service.create()).rejects.toThrow(error);
});

test("streams actual assistant progress and settles with one transcript message", async () => {
  const { provider, service } = setup({ tokensPerSecond: 20 });
  provider.setResponses([fauxAssistantMessage("An actual streamed answer")]);
  const session = await service.create();
  const snapshots: SnapshotResponse[] = [];
  const unsubscribe = await service.subscribe(
    session.id,
    (snapshot) => snapshots.push(snapshot),
    (error) => {
      throw new Error(error);
    },
  );
  const admission = await service.submit(session.id, "Hello");
  await service.get(session.id).conversation.waitForIdle(BACKGROUND_CONTEXT);
  const final = await service.snapshot(session.id);
  expect(
    snapshots.some(({ snapshot }) =>
      snapshot.operation?.streamingMessage?.content.some(
        (content) => content.type === "text" && content.text.length > 0,
      ),
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      snapshots.some(
        ({ snapshot }) =>
          snapshot.operation === null && snapshot.lastResult?.operationId === admission.operationId,
      ),
    )
    .toBe(true);
  expect(final.snapshot.operation).toBeNull();
  expect(final.snapshot.lastResult).toMatchObject({
    operationId: admission.operationId,
    status: "completed",
  });
  const messages = final.snapshot.transcript.flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
  expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(final.contextTokens).toBeGreaterThan(0);
  unsubscribe();
});

test("executes real tools and retains their results in the transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-agent-"));
  directories.push(directory);
  const path = join(directory, "example.txt");
  await writeFile(path, "Actual file content", "utf8");
  const { provider, service } = setup();
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path }, { id: "read-file" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("The file has been read"),
  ]);
  const session = await service.create();
  await service.submit(session.id, "Read the file");
  await service.get(session.id).conversation.waitForIdle(BACKGROUND_CONTEXT);
  const final = await service.snapshot(session.id);
  const tools = getTools(final.snapshot);
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({
    toolCallId: "read-file",
    toolName: "read",
    status: "settled",
    isError: false,
    args: { path },
  });
  expect(JSON.stringify(tools[0]!.result)).toContain("Actual file content");
});

test("reports real tool errors without claiming success", async () => {
  const { provider, service } = setup();
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read", { path: "/nonexistent-eta-test-file" }, { id: "missing-file" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The file does not exist"),
  ]);
  const session = await service.create();
  await service.submit(session.id, "Read the missing file");
  await service.get(session.id).conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect(getTools((await service.snapshot(session.id)).snapshot)[0]).toMatchObject({
    status: "settled",
    isError: true,
  });
});

test("a provider failure is published as a failed operation", async () => {
  const { provider, service } = setup();
  provider.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Unsupported test request" }),
  ]);
  const session = await service.create();
  await service.submit(session.id, "Fail this run");
  await service.get(session.id).conversation.waitForIdle(BACKGROUND_CONTEXT);
  const final = await service.snapshot(session.id);
  expect(final.snapshot.operation).toBeNull();
  expect(final.snapshot.lastResult).toMatchObject({
    status: "failed",
    error: { message: "Unsupported test request" },
  });
});

test("rejects a concurrent prompt and allows another prompt after stopping", async () => {
  const { provider, service } = setup({ tokensPerSecond: 50 });
  provider.setResponses([
    fauxAssistantMessage("A long running answer ".repeat(20)),
    fauxAssistantMessage("Next answer"),
  ]);
  const session = await service.create();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const unsubscribe = await service.subscribe(
    session.id,
    ({ snapshot }) => {
      if (snapshot.operation?.streamingMessage) markStarted();
    },
    () => {},
  );
  await service.submit(session.id, "Start");
  await started;
  await expect(service.submit(session.id, "Duplicate")).rejects.toThrow();
  await service.stop(session.id);
  expect((await service.snapshot(session.id)).snapshot.lastResult?.status).toBe("aborted");
  await service.submit(session.id, "Continue");
  await service.get(session.id).conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect((await service.snapshot(session.id)).snapshot.lastResult?.status).toBe("completed");
  unsubscribe();
});

test("a new subscription gets the current transcript and deletion closes the session", async () => {
  const { provider, service } = setup();
  provider.setResponses([fauxAssistantMessage("Already completed")]);
  const session = await service.create();
  await service.submit(session.id, "Hello");
  await service.get(session.id).conversation.waitForIdle(BACKGROUND_CONTEXT);
  const snapshots: SnapshotResponse[] = [];
  const unsubscribe = await service.subscribe(
    session.id,
    (snapshot) => snapshots.push(snapshot),
    () => {},
  );
  expect(snapshots[0]!.snapshot.transcript).toHaveLength(2);
  unsubscribe();
  await service.delete(session.id);
  await expect(service.snapshot(session.id)).rejects.toThrow("内存会话已不存在");
  await service.delete(session.id);
});

test("deleting a running session releases watches and permits a new session", async () => {
  const { provider, service } = setup({ tokensPerSecond: 20 });
  provider.setResponses([
    fauxAssistantMessage("An answer that remains running for a while".repeat(10)),
  ]);
  const session = await service.create();
  const errors: string[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const unsubscribe = await service.subscribe(
    session.id,
    ({ snapshot }) => {
      if (snapshot.operation?.streamingMessage) markStarted();
    },
    (error) => errors.push(error),
  );
  await service.submit(session.id, "Start");
  await started;
  await service.delete(session.id);
  unsubscribe();
  await expect(service.snapshot(session.id)).rejects.toThrow("内存会话已不存在");
  expect(errors).toEqual([]);
  expect((await service.create()).snapshot.operation).toBeNull();
});
