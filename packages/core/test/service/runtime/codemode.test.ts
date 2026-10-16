import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { defineTool } from "@eta/agent";
import type { JsonValue } from "@earendil-works/chord";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore } from "../../../src/client.ts";
import type { CoreClient } from "../../../src/client.ts";
import type { RuntimeSettings } from "../../../src/shared/runtime-settings.ts";
import { RuntimeCodemodeSandbox } from "../../../src/service/runtime/codemode.ts";
import type { ImageProcessor } from "../../../src/images/types.ts";
import type { CoreEnvironment } from "../../../src/service/environment.ts";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(
  initial: Partial<RuntimeSettings> = {},
  processImage?: ImageProcessor,
  environment: Partial<CoreEnvironment> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "eta-codemode-"));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "code-test",
    models: [
      { id: "one", input: ["text", "image"], inputLimits: { images: { maxPerMessage: 1 } } },
    ],
    tokensPerSecond: 100000,
  });
  const titles = fauxProvider({
    provider: "code-test",
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
  let settings: RuntimeSettings = { defaultThinkingLevel: "off", ...initial };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<RuntimeSettings>) => {
    settings = { ...settings, ...patch };
    for (const listener of listeners) listener();
  };
  const open = async () => {
    const core = await createCore({
      dataRoot: join(directory, "data"),
      home: directory,
      models,
      processImage,
      settings: {
        read: Effect.sync(() => settings),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      environment: { shutdown: "preserve", ...environment },
    });
    clients.push(core);
    return core;
  };
  const core = await open();
  const project = await core.registerProject(cwd);
  const workspace = (await core.workspaces(project.id))[0]!;
  const thread = await core.createThread(workspace.id);
  const run = async (client = core) => {
    const admission = await client.submit(thread.id, "Run tools");
    await expect
      .poll(
        async () =>
          ["completed", "failed", "aborted"].includes(
            (await client.operation(thread.id, admission.operationId)).status,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    const result = await client.operation(thread.id, admission.operationId);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    return client.openThread(thread.id);
  };
  return { core, thread, provider, update, run, open, cwd };
}

const script = (code: string) =>
  fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });

test("default Code mode executes sequential and parallel native tools, then switches both ways on the same thread", async () => {
  const f = await fixture();
  f.provider.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
      expect(getCurrentSystemPrompt(context.messages)).toContain("<codemode>");
      return script(
        'await Promise.all([tools.write({path:"a.txt",content:"A"}),tools.write({path:"b.txt",content:"B"})]); text(await tools.read({path:"a.txt"}));',
      );
    },
    fauxAssistantMessage("Code complete"),
  ]);
  const result = await f.run();
  expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe("A");
  expect(await readFile(join(f.cwd, "b.txt"), "utf8")).toBe("B");
  expect(JSON.stringify(result)).toContain("Code complete");
  f.update({ agentMode: "standard" });
  f.provider.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).some((tool) => tool.name === "write")).toBe(true);
      expect(getCurrentTools(context.messages).some((tool) => tool.name === "codemode")).toBe(
        false,
      );
      expect(getCurrentSystemPrompt(context.messages)).not.toContain("<codemode>");
      return fauxAssistantMessage(fauxToolCall("write", { path: "standard.txt", content: "S" }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("Standard complete"),
  ]);
  await f.run();
  expect(await readFile(join(f.cwd, "standard.txt"), "utf8")).toBe("S");
  f.update({ agentMode: "codemode" });
  f.provider.setResponses([script('text("back");'), fauxAssistantMessage("Back")]);
  expect(JSON.stringify(await f.run())).toContain("back");
}, 30000);

test("scripts cannot call disabled tools or upstream model globals", async () => {
  const f = await fixture();
  f.update({ disabledTools: ["write"] });
  f.provider.setResponses([
    script(
      'text(ALL_TOOLS); try { await tools.write({path:"forbidden",content:"bad"}); } catch(e) { text(e.message); } text(typeof models);',
    ),
    fauxAssistantMessage("Checked"),
  ]);
  const result = await f.run();
  expect(JSON.stringify(result)).toContain("undefined");
  await expect(readFile(join(f.cwd, "forbidden"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a paused nested approval survives settings changes and reopening in its original mode", async () => {
  const f = await fixture();
  f.update({ defaultSandboxMode: "read-only" });
  // The default sandbox is selected at thread creation; create another thread for this policy.
  const project = (await f.core.projects())[0]!;
  const workspace = (await f.core.workspaces(project.id))[0]!;
  const thread = await f.core.createThread(workspace.id);
  f.provider.setResponses([
    script('await tools.write({path:"approval.txt",content:"approved"}); text("written");'),
    fauxAssistantMessage("Done"),
  ]);
  const admission = await f.core.submit(thread.id, "Write with approval");
  await expect
    .poll(async () => (await f.core.openThread(thread.id)).snapshot.approvals?.length, {
      timeout: 15000,
    })
    .toBe(1);
  const waiting = (await f.core.openThread(thread.id)).snapshot;
  expect(waiting.operation?.runningTools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        toolName: "write",
        status: "waiting",
        parentToolCallId: expect.any(String),
        parentTaskId: expect.any(String),
      }),
    ]),
  );
  f.update({ agentMode: "standard" });
  await f.core.close();
  const reopened = await f.open();
  expect((await reopened.openThread(thread.id)).snapshot.recoveryRequired).toBe(true);
  await reopened.resume(thread.id);
  await expect
    .poll(async () => (await reopened.openThread(thread.id)).snapshot.approvals?.length, {
      timeout: 15000,
    })
    .toBe(1);
  const request = (await reopened.openThread(thread.id)).snapshot.approvals![0]!;
  await reopened.decideApproval(thread.id, request.id, true);
  await expect
    .poll(async () => (await reopened.operation(thread.id, admission.operationId)).status, {
      timeout: 15000,
    })
    .toBe("completed");
  expect(await readFile(join(f.cwd, "approval.txt"), "utf8")).toBe("approved");
}, 40000);

test("host timeout caps an unbounded script and close aborts outstanding workers", async () => {
  const sandbox = new RuntimeCodemodeSandbox();
  try {
    const result = await sandbox.start("while(true) {}", {
      startedAt: Date.now() - 300000 + 50,
      seed: 1,
      timeoutMs: Infinity,
      onCall() {},
    }).result;
    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
    const run = sandbox.start("while(true) {}", { startedAt: Date.now(), seed: 2, onCall() {} });
    await sandbox.close();
    expect(await run.result).toMatchObject({ ok: false, error: { kind: "aborted" } });
  } finally {
    await sandbox.close();
  }
});

test("children inherit the admitted mode after preferences change and retain their tool restrictions", async () => {
  const f = await fixture();
  f.provider.setResponses([
    () => {
      f.update({ agentMode: "standard" });
      return script(
        'text(await tools.subagent({action:"spawn",name:"worker",message:"Write child.txt",wait:true}));',
      );
    },
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
      return script(
        'if(ALL_TOOLS.some(t=>["schedule","subagent"].includes(t.name))) throw Error("restricted tool exposed"); await tools.write({path:"child.txt",content:"inherited"});',
      );
    },
    fauxAssistantMessage("Child done"),
    fauxAssistantMessage("Parent done"),
    fauxAssistantMessage("Report received"),
  ]);
  const result = await f.run();
  expect(await readFile(join(f.cwd, "child.txt"), "utf8")).toBe("inherited");
  expect(result.snapshot.configuration.agentMode).toBe("codemode");
  expect(result.snapshot.subagents).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "completed" })]),
  );
}, 30000);

test("scripts activate and remove skills and create schedules through the existing tools", async () => {
  const f = await fixture();
  const skill = join(f.cwd, ".agents/skills/check");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: check\ndescription: Check work\n---\nCODE_SKILL_INSTRUCTIONS",
  );
  f.provider.setResponses([
    script('text(await tools.load_skill({name:"check"}));'),
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("CODE_SKILL_INSTRUCTIONS");
      return script('text(await tools.unload_skill({name:"check"}));');
    },
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).not.toContain("CODE_SKILL_INSTRUCTIONS");
      return fauxAssistantMessage("Skills checked");
    },
  ]);
  await f.run();
  f.provider.setResponses([
    script(
      `text(await tools.schedule({action:"create",name:"Code plan",prompt:"Check work",rule:{type:"once",at:${Date.now() + 3600000}}}));`,
    ),
    fauxAssistantMessage("Scheduled"),
  ]);
  const opened = await f.run();
  const scheduledResult = opened.snapshot.transcript.findLast(
    ({ message }) => message.role === "toolResult" && message.toolName === "codemode",
  );
  if (scheduledResult?.message.role !== "toolResult") throw Error("Missing schedule script");
  expect(scheduledResult.message.details).toMatchObject({
    calls: [
      {
        name: "schedule",
        taskId: expect.any(String),
        parentTaskId: expect.any(String),
        result: { details: { kind: "schedule", action: "create", status: "applied" } },
      },
    ],
  });
  expect(await f.core.listSchedules()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "Code plan" })]),
  );
}, 30000);

test("nested rejection and cancellation do not write files", async () => {
  const f = await fixture({ defaultSandboxMode: "read-only" });
  for (const stop of [false, true]) {
    f.provider.setResponses([
      script('await tools.write({path:"denied.txt",content:"bad"});'),
      fauxAssistantMessage("Handled"),
    ]);
    const admission = await f.core.submit(f.thread.id, "Try writing");
    await expect
      .poll(async () => (await f.core.openThread(f.thread.id)).snapshot.approvals?.length, {
        timeout: 15000,
      })
      .toBe(1);
    if (stop) await f.core.stop(f.thread.id);
    else {
      const request = (await f.core.openThread(f.thread.id)).snapshot.approvals![0]!;
      await f.core.decideApproval(f.thread.id, request.id, false);
    }
    await expect
      .poll(async () => (await f.core.operation(f.thread.id, admission.operationId)).status, {
        timeout: 15000,
      })
      .toBe(stop ? "aborted" : "completed");
    await expect(readFile(join(f.cwd, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 30000);

test.each([false, true])(
  "image reads preserve processor notes, enforce the model image limit and respect blocking (processor=%s)",
  async (processed) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=";
    const f = await fixture(
      {},
      processed
        ? async () => ({
            type: "image",
            data: png,
            mimeType: "image/png",
            note: "Coordinates use the resized image.",
          })
        : undefined,
    );
    await writeFile(join(f.cwd, "image.png"), Buffer.from(png, "base64"));
    for (const blockImages of [false, true]) {
      f.update({ blockImages });
      f.provider.setResponses([
        script(
          `await tools.read({path:"image.png"}); await tools.read({path:"image.png"}); image("data:image/png;base64,${png}");`,
        ),
        (context) => {
          const last = context.messages.findLast((message) => message.role === "toolResult");
          expect(last?.role).toBe("toolResult");
          const content = last && Array.isArray(last.content) ? last.content : [];
          expect(content.filter((part) => part.type === "image")).toHaveLength(blockImages ? 0 : 1);
          if (processed)
            expect(JSON.stringify(content)).toContain("Coordinates use the resized image.");
          expect(JSON.stringify(content)).toContain("Image limit reached");
          return fauxAssistantMessage("Image checked");
        },
      ]);
      await f.run();
    }
  },
  30000,
);

test("nested previews preserve structured JSON values without interpreting content-like records", async () => {
  const values: JsonValue[] = [
    0,
    false,
    null,
    [],
    [1, 2],
    { type: "record", count: 7 },
    { type: "text", text: "A structured record, not a display block" },
    [{ type: "text", text: "A structured array, not display content" }],
    "",
    "plain string",
  ];
  const tool = defineTool({
    name: "structured_preview",
    description: "Return a structured JSON value",
    parameters: Type.Object({ index: Type.Integer({ minimum: 0, maximum: values.length - 1 }) }),
    structuredOutputSchema: Type.Unknown(),
    execute: async ({ index }) => ({ structuredOutput: values[index]! }),
  });
  const f = await fixture({}, undefined, {
    extensions: () => [{ name: "structured-preview-test", tools: [tool] }],
  });
  f.provider.setResponses([
    script(`
      const expected = ${JSON.stringify(values)};
      const actual = await Promise.all(expected.map((_, index) => tools.structured_preview({index})));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error("Bridge lost JSON");
      text("All structured values intact");
    `),
    fauxAssistantMessage("Checked previews"),
  ]);
  const opened = await f.run();
  const result = opened.snapshot.transcript.find(
    ({ message }) => message.role === "toolResult" && message.toolName === "codemode",
  )?.message;
  if (result?.role !== "toolResult") throw Error("Missing Code mode result");
  expect(result.isError, JSON.stringify(result)).toBe(false);
  const details = Schema.decodeUnknownSync(
    Schema.Struct({
      calls: Schema.Array(
        Schema.Struct({
          result: Schema.Struct({
            content: Schema.Array(
              Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
            ),
          }),
        }),
      ),
    }),
  )(result.details);
  expect(details.calls).toHaveLength(values.length);
  for (const [index, call] of details.calls.entries()) {
    expect(
      call.result.content,
      `Missing structured preview for ${JSON.stringify(values[index])}`,
    ).toHaveLength(1);
    expect(JSON.parse(call.result.content[0]!.text)).toEqual(values[index]);
  }
}, 20000);

test("structured tool failures remain inspectable and oversized script output spills to a file", async () => {
  const f = await fixture();
  f.provider.setResponses([
    script(
      '// @options: {"max_output_tokens": 100}\nconst result = await tools.bash({command:"exit 7"}); if(result.exitCode!==7) throw Error("lost structured exit"); text("x".repeat(10000));',
    ),
    fauxAssistantMessage("Checked output"),
  ]);
  const opened = await f.run();
  const result = opened.snapshot.transcript.find(
    ({ message }) => message.role === "toolResult" && message.toolName === "codemode",
  );
  expect(result?.message.role).toBe("toolResult");
  if (result?.message.role !== "toolResult") throw Error("Missing script result");
  expect(result.message.isError, JSON.stringify(result.message)).toBe(false);
  expect(result.message.details).toMatchObject({
    fullOutputPath: expect.any(String),
    calls: [expect.objectContaining({ name: "bash", status: "error" })],
  });
}, 20000);

test("the worker rejects allocations beyond the host memory cap", async () => {
  const sandbox = new RuntimeCodemodeSandbox();
  try {
    const result = await sandbox.start("new Uint8Array(256 * 1024 * 1024);", {
      startedAt: Date.now(),
      seed: 1,
      timeoutMs: 5000,
      onCall() {},
    }).result;
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "script", message: expect.stringMatching(/memory/i) },
    });
  } finally {
    await sandbox.close();
  }
});

test("worker capacity is shared across thread sandboxes", async () => {
  const sandboxes = Array.from({ length: 5 }, () => new RuntimeCodemodeSandbox());
  try {
    for (const sandbox of sandboxes.slice(0, 4)) {
      let ready!: () => void;
      const called = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const run = sandbox.start("await tools.hold({});", {
        startedAt: Date.now(),
        seed: 1,
        tools: [{ name: "hold" }],
        timeoutMs: 10000,
        onCall: ready,
      });
      await Promise.race([
        called,
        run.result.then((result) => {
          throw Error(`Worker ended before hold: ${JSON.stringify(result)}`);
        }),
      ]);
    }
    const denied = await sandboxes[4]!.start("text('over capacity');", {
      startedAt: Date.now(),
      seed: 1,
      timeoutMs: 5000,
      onCall() {},
    }).result;
    expect(denied).toMatchObject({
      ok: false,
      error: { kind: "sandbox", message: expect.stringContaining("并发已满") },
    });
  } finally {
    await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
  }
}, 20000);

test("unavailable Code mode reports how to switch modes and leaves standard mode usable", async () => {
  const f = await fixture({}, undefined, {
    codemodeAssets: {
      worker: join(tmpdir(), "eta-missing-codemode-worker.mjs"),
      wasm: join(tmpdir(), "eta-missing-codemode.wasm"),
    },
  });
  f.provider.setResponses([
    script('text("cannot run");'),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("权限切换普通模式");
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
      return fauxAssistantMessage("Reported missing resources");
    },
  ]);
  expect((await f.run()).snapshot.configuration.agentMode).toBe("codemode");
  f.update({ agentMode: "standard" });
  f.provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "standard-fallback.txt", content: "manual choice" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Standard works"),
  ]);
  await f.run();
  expect(await readFile(join(f.cwd, "standard-fallback.txt"), "utf8")).toBe("manual choice");
}, 20000);
