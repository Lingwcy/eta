import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeJsonlStorage } from "@eta/agent/storage/jsonl/node";
import type { Storage } from "@eta/agent";
import { describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, LiveDoc } from "@eta/agent";
import { createSubagentsExtension, SubagentsDoc, childPath } from "./extension.ts";
import { defaultSubagentSettings } from "../../../subagents.ts";
import type { SubagentSettings } from "../../../subagents.ts";

async function setup(
  policy: SubagentSettings = defaultSubagentSettings,
  storage: Storage = new MemoryStorage(),
) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 30 }, () => () => fauxAssistantMessage([fauxText("done")])),
  );
  const registry = createRegistry();
  let harness: Harness;
  const manager = createSubagentsExtension({
    harness: () => harness,
    settings: async () => policy,
    available: async (provider) => provider === "faux",
    clamp: () => "off",
    instructions: async () => "Fresh project instructions",
  });
  registry.install(manager.extension);
  harness = await Harness.open(
    storage,
    {
      models,
      registry,
      conversationCreated: async (tx) => {
        await tx.doc(SubagentsDoc);
      },
    },
    context,
  );
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "MAIN BIAS" },
  });
  const settle = async () => {
    const doc = (await harness.snapshot(SubagentsDoc, context))!;
    for (const child of doc.agents)
      for (const task of [...child.pending, ...child.active, ...(child.settling ?? [])])
        expect((await harness.waitForTask(task, context)).state).toMatchObject({
          status: "terminal",
          outcome: { status: "completed" },
        });
    await root.waitForIdle(context);
  };
  return { harness, root, manager, settle, faux };
}

describe("desktop subagents", () => {
  it("separates fork history from independent history and replaces parent instructions", async () => {
    const { harness, root, manager, settle } = await setup();
    try {
      await (await root.submit({ type: "input", content: "ROOT SECRET" }, context)).wait(context);
      await manager.execute(
        { action: "spawn", name: "forked", fork: true, message: "work" },
        root.id,
        "fork",
      );
      await manager.execute(
        { action: "spawn", name: "review", message: "review" },
        root.id,
        "review",
      );
      await settle();
      const children = await manager.list();
      expect(children.map((child) => child.path)).toEqual(["/root/forked", "/review"]);
      for (const child of children) {
        const record = (await harness.snapshot(SubagentsDoc, context))!.agents.find(
          (agent) => agent.path === child.path,
        )!;
        const conversation = (await harness.conversation(record.conversationId, context))!;
        const view = await conversation.context(context);
        expect(JSON.stringify(view.messages).includes("ROOT SECRET")).toBe(child.fork);
        expect((await conversation.agent(context)).instructions).not.toContain("MAIN BIAS");
      }
      const rootView = await root.context(context);
      expect(JSON.stringify(rootView.messages)).toContain("[/review completed] done");
    } finally {
      await harness.close(context);
    }
  });
  it("deduplicates replayed spawn and rejects unavailable or forbidden models and excess depth", async () => {
    const policy = {
      ...defaultSubagentSettings,
      maxDepth: 1,
      allowedModels: [{ provider: "faux", modelId: "faux-1" }],
    };
    const { harness, root, manager, settle } = await setup(policy);
    try {
      const command = { action: "spawn", name: "worker", message: "work" } as const;
      await manager.execute(command, root.id, "same");
      await manager.execute(command, root.id, "same");
      await settle();
      expect(await manager.list()).toHaveLength(1);
      const child = (await harness.snapshot(SubagentsDoc, context))!.agents[0]!;
      await expect(
        manager.execute({ action: "spawn", message: "nested" }, child.conversationId, "nested"),
      ).rejects.toThrow("深度");
      await expect(
        manager.execute(
          { action: "spawn", message: "bad", model: { provider: "other", modelId: "x" } },
          root.id,
          "bad",
        ),
      ).rejects.toThrow("候选模型");
      await expect(
        manager.execute(
          { action: "spawn", message: "duplicate", name: "worker" },
          root.id,
          "duplicate",
        ),
      ).rejects.toThrow("已存在");
    } finally {
      await harness.close(context);
    }
  });
  it("defaults model scope to the current root model and follows root model changes", async () => {
    const { harness, root, manager, settle } = await setup();
    try {
      const command = {
        action: "spawn",
        message: "work",
        model: { provider: "faux", modelId: "faux-2" },
      } as const;
      await expect(manager.execute(command, root.id, "forbidden")).rejects.toThrow("候选模型");
      await root.configure({ model: command.model }, context);
      await manager.execute(command, root.id, "allowed");
      await settle();
      expect((await manager.list())[0]?.model).toEqual(command.model);
    } finally {
      await harness.close(context);
    }
  });
  it("queues paused children and resumes their original task", async () => {
    const { harness, root, manager, settle } = await setup();
    try {
      await manager.execute({ action: "spawn", name: "paused", message: "task" }, root.id, "spawn");
      await manager.execute({ action: "pause", path: "/paused" }, root.id, "pause");
      expect((await manager.list())[0]?.status).toBe("paused");
      await manager.execute({ action: "resume", path: "/paused" }, root.id, "resume");
      await settle();
      expect((await manager.list())[0]?.status).toBe("completed");
    } finally {
      await harness.close(context);
    }
  });
  it("validates paths independently of execution ancestry", () => {
    expect(childPath("/root/worker", "review", false)).toBe("/review");
    expect(childPath("/root/worker", "review", true)).toBe("/root/worker/review");
    expect(() => childPath("/root", "../bad", true)).toThrow();
  });
});

it("reserves one concurrency slot per child and queues excess work", async () => {
  const { harness, root, manager, settle, faux } = await setup({
    ...defaultSubagentSettings,
    maxConcurrent: 1,
  });
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  faux.setResponses([
    (_messages, options) => {
      ready.resolve();
      options?.signal?.addEventListener(
        "abort",
        () => answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      return answer.promise;
    },
    ...Array.from({ length: 10 }, () => () => fauxAssistantMessage("done")),
  ]);
  try {
    await manager.execute({ action: "spawn", name: "one", message: "one" }, root.id, "one");
    harness.resume();
    await ready.promise;
    await manager.execute({ action: "spawn", name: "two", message: "two" }, root.id, "two");
    expect((await manager.list()).map((child) => child.status)).toEqual(["running", "queued"]);
    answer.resolve(fauxAssistantMessage("done"));
    await settle();
    expect((await manager.list()).map((child) => child.status)).toEqual(["completed", "completed"]);
  } finally {
    answer.resolve(fauxAssistantMessage("done"));
    await harness.close(context);
  }
});

it("restores paused work and the entire conversation tree from the same JSONL storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-subagents-"));
  let harness: Harness | undefined;
  try {
    const first = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context, { fsync: true }),
    );
    harness = first.harness;
    await first.manager.execute(
      { action: "spawn", name: "review", message: "review task" },
      first.root.id,
      "spawn",
    );
    await first.manager.execute({ action: "pause", path: "/review" }, first.root.id, "pause");
    await harness.close(context);
    const second = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context, { fsync: true }),
    );
    harness = second.harness;
    expect((await second.manager.list())[0]?.status).toBe("paused");
    expect((await harness.inspect(context)).scheduling).toBe("paused");
    await second.manager.execute({ action: "resume", path: "/review" }, second.root.id, "resume");
    await second.settle();
    expect((await second.manager.list())[0]?.status).toBe("completed");
    const contents = await readFile(join(directory, "main.jsonl"), "utf8");
    expect(contents).toContain("review task");
    expect(contents).toContain("[/review completed] done");
    const root = await second.root.context(context);
    expect(JSON.stringify(root.messages).match(/\[\/review completed\]/g)).toHaveLength(1);
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

it("recovers an in-flight child request without duplicating its input or report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-subagent-active-"));
  let harness: Harness | undefined;
  try {
    const first = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context, { fsync: true }),
    );
    harness = first.harness;
    const ready = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    first.faux.setResponses([
      (_request, options) => {
        ready.resolve();
        options?.signal?.addEventListener(
          "abort",
          () => answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
        return answer.promise;
      },
    ]);
    await first.manager.execute(
      { action: "spawn", name: "worker", message: "unique work request" },
      first.root.id,
      "spawn",
    );
    harness.resume();
    await ready.promise;
    await harness.close(context);
    const second = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context, { fsync: true }),
    );
    harness = second.harness;
    await second.settle();
    expect((await second.manager.list())[0]?.status).toBe("completed");
    const child = (await harness.snapshot(SubagentsDoc, context))!.agents[0]!;
    const conversation = (await harness.conversation(child.conversationId, context))!;
    const view = await conversation.context(context);
    expect(
      view.messages.filter(
        (message) => message.role === "user" && message.content === "unique work request",
      ),
    ).toHaveLength(1);
    const rootView = await second.root.context(context);
    expect(
      rootView.messages.filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("[/worker completed]"),
      ),
    ).toHaveLength(1);
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

it("applies changed model scope to the next request of an existing child", async () => {
  const policy = { ...defaultSubagentSettings };
  const { harness, root, manager, settle } = await setup(policy);
  try {
    await manager.execute({ action: "spawn", name: "worker", message: "work" }, root.id, "spawn");
    await settle();
    policy.allowedModels = [{ provider: "other", modelId: "forbidden" }];
    await manager.execute(
      { action: "send", path: "/worker", message: "more work" },
      root.id,
      "send",
    );
    await settle();
    expect((await manager.list())[0]).toMatchObject({ status: "failed" });
  } finally {
    await harness.close(context);
  }
});

it("waits for independently named descendants and reports their parent's final synthesis", async () => {
  const { harness, root, manager, settle, faux } = await setup({
    ...defaultSubagentSettings,
    maxConcurrent: 1,
  });
  const parentReady = Promise.withResolvers<void>();
  const parentAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const descendantReady = Promise.withResolvers<void>();
  const descendantAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  faux.setResponses([
    () => {
      parentReady.resolve();
      return parentAnswer.promise;
    },
    () => {
      descendantReady.resolve();
      return descendantAnswer.promise;
    },
    () => fauxAssistantMessage("Synthesis including the last descendant"),
    () => fauxAssistantMessage("Final root answer"),
  ]);
  try {
    await manager.execute(
      { action: "spawn", name: "parent", message: "research" },
      root.id,
      "parent",
    );
    harness.resume();
    await parentReady.promise;
    const parent = (await harness.snapshot(SubagentsDoc, context))!.agents[0]!;
    await manager.execute(
      { action: "spawn", name: "independent", message: "last source" },
      parent.conversationId,
      "descendant",
    );
    parentAnswer.resolve(fauxAssistantMessage("Premature parent answer"));
    await descendantReady.promise;
    expect((await manager.list()).map((child) => child.status)).toEqual(["running", "running"]);
    expect(JSON.stringify((await root.context(context)).messages)).not.toContain(
      "[/parent completed]",
    );
    descendantAnswer.resolve(fauxAssistantMessage("Last source result"));
    await settle();
    expect((await manager.list()).map((child) => child.status)).toEqual(["completed", "completed"]);
    const messages = JSON.stringify((await root.context(context)).messages);
    expect(messages).toContain("[/parent completed] Synthesis including the last descendant");
    expect(messages).not.toContain("Premature parent answer");
    expect(messages.match(/\[\/parent completed\]/g)).toHaveLength(1);
  } finally {
    parentAnswer.resolve(fauxAssistantMessage("done"));
    descendantAnswer.resolve(fauxAssistantMessage("done"));
    await harness.close(context);
  }
});

it("restores a parent waiting for a descendant without losing or duplicating its final report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-subagent-join-"));
  let harness: Harness | undefined;
  const parentReady = Promise.withResolvers<void>();
  const parentAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const childReady = Promise.withResolvers<void>();
  const childAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  try {
    const policy = { ...defaultSubagentSettings, maxConcurrent: 1 };
    const first = await setup(
      policy,
      await openNodeJsonlStorage(directory, context, { fsync: true }),
    );
    harness = first.harness;
    first.faux.setResponses([
      () => {
        parentReady.resolve();
        return parentAnswer.promise;
      },
      (_messages, options) => {
        childReady.resolve();
        options?.signal?.addEventListener(
          "abort",
          () => childAnswer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
        return childAnswer.promise;
      },
    ]);
    await first.manager.execute(
      { action: "spawn", name: "parent", message: "research" },
      first.root.id,
      "parent",
    );
    harness.resume();
    await parentReady.promise;
    const parent = (await harness.snapshot(SubagentsDoc, context))!.agents[0]!;
    await first.manager.execute(
      { action: "spawn", name: "last", message: "last source" },
      parent.conversationId,
      "last",
    );
    parentAnswer.resolve(fauxAssistantMessage("Incomplete first answer"));
    await childReady.promise;
    expect((await first.manager.list())[0]?.status).toBe("running");
    await harness.close(context);
    const next = await setup(
      policy,
      await openNodeJsonlStorage(directory, context, { fsync: true }),
    );
    harness = next.harness;
    await next.settle();
    expect((await next.manager.list()).map((child) => child.status)).toEqual([
      "completed",
      "completed",
    ]);
    const messages = JSON.stringify((await next.root.context(context)).messages);
    expect(messages).toContain("[/parent completed] done");
    expect(messages).not.toContain("Incomplete first answer");
    expect(messages.match(/\[\/parent completed\]/g)).toHaveLength(1);
  } finally {
    parentAnswer.resolve(fauxAssistantMessage("done"));
    childAnswer.resolve(fauxAssistantMessage("done"));
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps the original root input running while children work and resumes it with their result", async () => {
  const { harness, root, manager, faux } = await setup();
  const childReady = Promise.withResolvers<void>();
  const childAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  let rootRequests = 0;
  faux.setResponses(
    Array.from({ length: 8 }, () => (request) => {
      const lastUser = request.messages.findLast((message) => message.role === "user");
      if (lastUser?.content === "child-work") {
        childReady.resolve();
        return childAnswer.promise;
      }
      rootRequests++;
      if (rootRequests === 1)
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "spawn",
              name: "sum",
              fork: false,
              message: "child-work",
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(rootRequests === 2 ? "正在计算" : "Final result: 13");
    }),
  );
  try {
    const input = await root.submit(
      { type: "input", content: "delegate this calculation" },
      context,
    );
    await childReady.promise;
    await expect
      .poll(async () => (await harness.snapshot(SubagentsDoc, context))?.waiters?.length)
      .toBe(1);
    expect((await input.status(context)).status).toBe("placed");
    expect((await harness.snapshot(LiveDoc, root.id, context))?.run?.inputs).toContain(input.id);
    expect(rootRequests).toBe(2);
    childAnswer.resolve(fauxAssistantMessage("13"));
    const result = await input.wait(context);
    expect(result.status).toBe("done");
    await root.waitForIdle(context);
    expect(rootRequests).toBe(3);
    expect((await manager.list())[0]?.status).toBe("completed");
    if (result.status === "done" && result.type === "input") {
      const entries = (await root.context(context)).entries;
      expect(JSON.stringify(entries.find((entry) => entry.id === result.answer)?.model)).toContain(
        "Final result: 13",
      );
    }
  } finally {
    childAnswer.resolve(fauxAssistantMessage("13"));
    await harness.close(context);
  }
});
