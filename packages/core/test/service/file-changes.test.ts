import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { promisify } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { join } from "node:path";
import { Effect, Predicate } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type EntryId } from "@eta/agent";
import { openNodeJsonlStorage } from "@eta/agent/storage/jsonl/node";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore, type CoreClient } from "../../src/client.ts";
import type { RuntimeSettings } from "../../src/shared/runtime-settings.ts";
import type { SnapshotResponse } from "../../src/agent/protocol.ts";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const core of clients.splice(0)) await core.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(agentMode: "standard" | "codemode" = "standard") {
  const directory = await mkdtemp(join(tmpdir(), "eta-history-diff-"));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "diff-test",
    models: [{ id: "one" }],
    tokensPerSecond: 100000,
  });
  const titles = fauxProvider({
    provider: "diff-title",
    models: [{ id: "one" }],
    tokensPerSecond: 100000,
  });
  const models = createModels();
  models.setProvider({
    ...provider.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? titles.provider.streamSimple(model, context, options)
        : provider.provider.streamSimple(model, context, options),
  });
  const settings: RuntimeSettings = { defaultThinkingLevel: "off", agentMode };
  const open = async () => {
    const core = await createCore({
      dataRoot: join(directory, "data"),
      home: directory,
      models,
      settings: { read: Effect.succeed(settings), subscribe: () => () => {} },
      environment: { shutdown: "preserve" },
    });
    clients.push(core);
    return core;
  };
  const core = await open();
  const project = await core.registerProject(cwd);
  const workspace = (await core.workspaces(project.id))[0]!;
  const thread = await core.createThread(workspace.id, undefined, {
    provider: "diff-test",
    modelId: "one",
    thinkingLevel: "off",
    sandboxMode: "danger-full-access",
  });
  const run = async () => {
    const admission = await core.submit(thread.id, "Make the file changes");
    await expect
      .poll(async () => (await core.operation(thread.id, admission.operationId)).status, {
        timeout: 20000,
      })
      .toBe("completed");
    return core.openThread(thread.id);
  };
  return { core, open, cwd, directory, thread, workspace, provider, run };
}

function references(value: unknown): Array<{ id: string; path: string; status: string }> {
  const found = new Map<string, { id: string; path: string; status: string }>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!Predicate.isObject(value)) return;
    const ref = value.fileChange;
    if (
      Predicate.isObject(ref) &&
      typeof ref.id === "string" &&
      typeof ref.path === "string" &&
      typeof ref.status === "string"
    )
      found.set(ref.id, { id: ref.id, path: ref.path, status: ref.status });
    Object.values(value).forEach(visit);
  };
  visit(value);
  return [...found.values()];
}
const tool = (name: string, args: Record<string, JsonValue>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const script = (code: string) => tool("codemode", { code });

test.skipIf(process.platform === "win32")(
  "history diff rejects a FIFO artifact without waiting for a writer",
  async () => {
    const f = await fixture();
    f.provider.setResponses([
      tool("write", { path: "sample.ts", content: "saved\n" }),
      fauxAssistantMessage("Done"),
    ]);
    const [reference] = references(await f.run());
    expect(reference?.status).toBe("recorded");
    const input = { threadId: f.thread.id, changeId: reference!.id };
    expect(await f.core.fileChangeDiff(input)).toMatchObject({
      status: "ready",
      patch: expect.stringContaining("+saved"),
    });
    const artifact = join(
      f.thread.thread.sessionRef.metadata.path,
      "file-changes",
      reference!.id + ".json",
    );
    await rm(artifact);
    await promisify(execFile)("mkfifo", [artifact]);
    let settled = false;
    const result = f.core.fileChangeDiff(input).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    let writer: number | undefined;
    try {
      await expect.poll(() => settled, { timeout: 2000 }).toBe(true);
      expect(await result).toMatchObject({ error: { code: "StorageCorrupt" } });
    } finally {
      try {
        writer = openSync(artifact, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENXIO")) throw error;
      }
      try {
        await result;
      } finally {
        if (writer !== undefined) closeSync(writer);
      }
    }
  },
  30_000,
);

test.each(["standard", "codemode"] as const)(
  "%s history remains immutable across later writes, directory removal and restart",
  async (mode) => {
    const f = await fixture(mode);
    f.provider.setResponses(
      mode === "standard"
        ? [
            tool("write", { path: "sample.ts", content: "first\n" }),
            tool("edit", { path: "sample.ts", edits: [{ oldText: "first", newText: "second" }] }),
            fauxAssistantMessage("Done"),
          ]
        : [
            script(
              String.raw`await tools.write({path:"sample.ts",content:"first\n"});await tools.edit({path:"sample.ts",edits:[{oldText:"first",newText:"second"}]});`,
            ),
            fauxAssistantMessage("Done"),
          ],
    );
    const result = await f.run();
    const refs = references(result);
    expect(refs, JSON.stringify(result)).toHaveLength(2);
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(2);
    expect(refs.every((ref) => ref.status === "recorded")).toBe(true);
    expect(JSON.stringify(result.snapshot)).not.toContain('"patch"');
    const initial = await Promise.all(
      refs.map((ref) => f.core.fileChangeDiff({ threadId: f.thread.id, changeId: ref.id })),
    );
    expect(initial.every((diff) => diff.status === "ready")).toBe(true);
    expect(JSON.stringify(initial)).toContain("first");
    expect(JSON.stringify(initial)).toContain("second");
    await writeFile(join(f.cwd, "sample.ts"), "third current contents\n");
    expect(
      await Promise.all(
        refs.map((ref) => f.core.fileChangeDiff({ threadId: f.thread.id, changeId: ref.id })),
      ),
    ).toEqual(initial);
    const other = await f.core.createThread(f.workspace.id);
    expect(await f.core.fileChangeDiff({ threadId: other.id, changeId: refs[0]!.id })).toEqual({
      status: "unavailable",
      reason: "not-recorded",
    });
    await f.core.close();
    await rm(f.cwd, { recursive: true });
    const reopened = await f.open();
    expect(
      await Promise.all(
        refs.map((ref) => reopened.fileChangeDiff({ threadId: f.thread.id, changeId: ref.id })),
      ),
    ).toEqual(initial);
    const metadata = await reopened.threadMetadata(f.thread.id);
    const artifactDirectory = join(metadata.sessionRef.metadata.path, "file-changes");
    expect(await readdir(artifactDirectory)).toHaveLength(2);
    await reopened.deleteThread(f.thread.id);
    await expect(access(artifactDirectory)).rejects.toThrow();
    await expect(
      reopened.fileChangeDiff({ threadId: f.thread.id, changeId: refs[0]!.id }),
    ).rejects.toThrow();
  },
  45000,
);

test("large Code mode patches are read on demand while transcript details stay small", async () => {
  const f = await fixture("codemode");
  await writeFile(join(f.cwd, "preview.txt"), "x".repeat(5000));
  f.provider.setResponses([
    script(
      String.raw`for (let i = 0; i < 9; i++) await tools.read({path:"preview.txt"}); await tools.write({path:"large.ts",content:Array.from({length:1500},(_,i)=>"export const item"+i+" = "+i+";").join("\n")});`,
    ),
    fauxAssistantMessage("Done"),
  ]);
  const result = await f.run();
  const refs = references(result);
  expect(refs).toHaveLength(1);
  const diff = await f.core.fileChangeDiff({ threadId: f.thread.id, changeId: refs[0]!.id });
  expect(diff.status).toBe("ready");
  if (diff.status !== "ready") throw new Error("Missing history");
  expect(diff.patch.length).toBeGreaterThan(8000);
  expect(diff.patch).toContain("item1499");
  expect(JSON.stringify(result.snapshot)).not.toContain("export const item1499");
  const metadata = await f.core.threadMetadata(f.thread.id);
  const directory = join(metadata.sessionRef.metadata.path, "file-changes");
  const file = (await readdir(directory))[0]!;
  const artifact = JSON.parse(await readFile(join(directory, file), "utf8"));
  artifact.state = "uncertain";
  await writeFile(join(directory, file), JSON.stringify(artifact));
  expect(await f.core.fileChangeDiff({ threadId: f.thread.id, changeId: refs[0]!.id })).toEqual({
    status: "unavailable",
    reason: "uncertain",
  });
  expect(await f.core.fileChangeDiff({ threadId: f.thread.id, changeId: "not-recorded" })).toEqual({
    status: "unavailable",
    reason: "not-recorded",
  });
}, 30000);

test("a child uses the same capture boundary but its own durable change identity", async () => {
  const f = await fixture("codemode");
  f.provider.setResponses([
    script(
      `text(await tools.subagent({action:"spawn",name:"worker",message:"Write child.ts",wait:true}));`,
    ),
    script(String.raw`await tools.write({path:"child.ts",content:"child contents\n"});`),
    fauxAssistantMessage("Child done"),
    fauxAssistantMessage("Parent done"),
    fauxAssistantMessage("Report received"),
  ]);
  const result = await f.run();
  const child = result.snapshot.subagents?.find((child) => child.status === "completed");
  expect(child).toBeDefined();
  const snapshots: SnapshotResponse[] = [];
  const errors: string[] = [];
  const stop = await f.core.subscribe(
    f.thread.id,
    (value) => {
      snapshots.push(value);
    },
    (error) => {
      errors.push(error);
    },
    child!.path,
  );
  try {
    await expect.poll(() => references(snapshots.at(-1)).length, { timeout: 10000 }).toBe(1);
    const ref = references(snapshots.at(-1))[0]!;
    expect(ref.path).toBe("child.ts");
    const diff = await f.core.fileChangeDiff({ threadId: f.thread.id, changeId: ref.id });
    expect(diff.status).toBe("ready");
    if (diff.status !== "ready") throw new Error("Missing child history");
    expect(diff.patch).toContain("child contents");
    expect(errors).toEqual([]);
  } finally {
    stop();
  }
}, 45000);

test("legacy edit details are read from their persisted entry without a runtime or working directory", async () => {
  const f = await fixture();
  const metadata = await f.core.threadMetadata(f.thread.id);
  await f.core.close();
  const storage = await openNodeJsonlStorage(metadata.sessionRef.metadata.path, BACKGROUND_CONTEXT);
  const id = await storage.mintId<EntryId>();
  const patch = "--- old.ts\n+++ old.ts\n@@ -1 +1 @@\n-old\n+historical\n";
  try {
    await storage.commit(
      [
        {
          type: "entry",
          value: {
            id,
            conversationId: ROOT_CONVERSATION_ID,
            kind: "pi.tool-result",
            data: { diagnostics: [] },
            model: [
              { role: "system", content: "legacy context", timestamp: 1 },
              {
                role: "toolResult",
                toolCallId: "old-call",
                toolName: "edit",
                content: [{ type: "text", text: "Edited" }],
                details: { patch },
                isError: false,
                timestamp: 1,
              },
            ],
          },
        },
      ],
      BACKGROUND_CONTEXT,
    );
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
  await rm(f.cwd, { recursive: true });
  const reopened = await f.open();
  expect(
    await reopened.fileChangeDiff({ threadId: f.thread.id, changeId: `legacy:${id}:1` }),
  ).toEqual({ status: "ready", path: "", patch });
  expect(
    await reopened.fileChangeDiff({ threadId: f.thread.id, changeId: `legacy:${id}:0` }),
  ).toEqual({ status: "unavailable", reason: "not-recorded" });
  await expect(
    reopened.fileChangeDiff({ threadId: f.thread.id, changeId: "../../outside" }),
  ).rejects.toThrow();
  await expect(
    reopened.fileChangeDiff({ threadId: "missing-thread", changeId: "not-recorded" }),
  ).rejects.toThrow();
});

test("a full session history quota still applies writes and reports a bounded unavailable record", async () => {
  const f = await fixture();
  const metadata = await f.core.threadMetadata(f.thread.id);
  const directory = join(metadata.sessionRef.metadata.path, "file-changes");
  await mkdir(directory);
  // Only names and sizes are read to admit the next record; existing records are not evicted.
  await Promise.all(
    Array.from({ length: 2000 }, (_, index) =>
      writeFile(join(directory, `${index.toString(16).padStart(64, "0")}.json`), "{}"),
    ),
  );
  f.provider.setResponses([
    tool("write", { path: "quota.ts", content: "applied despite history quota" }),
    fauxAssistantMessage("Done"),
  ]);
  const result = await f.run();
  expect(await readFile(join(f.cwd, "quota.ts"), "utf8")).toBe("applied despite history quota");
  const refs = references(result);
  expect(refs).toHaveLength(1);
  expect(refs[0]!.status).toBe("too-large");
  expect(await f.core.fileChangeDiff({ threadId: f.thread.id, changeId: refs[0]!.id })).toEqual({
    status: "unavailable",
    reason: "too-large",
  });
  expect(await readdir(directory)).toHaveLength(2000);
}, 30000);
