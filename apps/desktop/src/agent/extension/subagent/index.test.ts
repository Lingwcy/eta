import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeJsonlStorage } from "@eta/agent/storage/jsonl/node";
import type { Storage } from "@eta/agent";
import { describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, LiveDoc } from "@eta/agent";
import { createSubagentsExtension, SubagentsDoc } from "./index.ts";
import { childPath } from "./state.ts";
import { DesktopServiceError } from "../../../main/service/errors.ts";
import { defaultSubagentSettings } from "../../../shared/subagents.ts";
import type { SubagentSettings } from "../../../shared/subagents.ts";

const invalid = (message: string): never => {
  throw new DesktopServiceError({ code: "InvalidInput", message });
};

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
    invalid,
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
  it("rejects new delegated work while disabled, while keeping existing children manageable", async () => {
    const policy = { ...defaultSubagentSettings };
    const { harness, root, manager, settle } = await setup(policy);
    try {
      await manager.execute({ action: "spawn", name: "worker", message: "work" }, root.id, "spawn");
      await manager.execute({ action: "pause", path: "/worker" }, root.id, "pause");
      policy.enabled = false;
      await expect(
        manager.execute({ action: "spawn", name: "blocked", message: "work" }, root.id, "blocked"),
      ).rejects.toThrow("子智能体已关闭");
      await expect(
        manager.execute({ action: "send", path: "/worker", message: "more work" }, root.id, "send"),
      ).rejects.toThrow("子智能体已关闭");
      // Already-admitted requests remain idempotent even if the setting changed before replay.
      await manager.execute({ action: "spawn", name: "worker", message: "work" }, root.id, "spawn");
      expect(await manager.list()).toHaveLength(1);
      expect((await manager.list())[0]?.status).toBe("paused");
      await manager.execute({ action: "resume", path: "/worker" }, root.id, "resume");
      await manager.execute({ action: "stop", path: "/worker" }, root.id, "stop");
      harness.resume();
      await expect.poll(async () => (await manager.list())[0]?.status).toBe("stopped");
      policy.enabled = true;
      await manager.execute(
        { action: "send", path: "/worker", message: "continue work" },
        root.id,
        "send",
      );
      await settle();
      expect((await manager.list())[0]?.status).toBe("completed");
    } finally {
      await harness.close(context);
    }
  });

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
      const command = {
        action: "spawn",
        name: "worker",
        message: "work",
        canDelegate: true,
      } as const;
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
  it("falls back to enabled models when the parent model is forbidden or unavailable", async () => {
    const fallback = { provider: "faux", modelId: "faux-2" };
    const policy = {
      ...defaultSubagentSettings,
      allowedModels: [{ provider: "unavailable", modelId: "missing" }, fallback],
    };
    const { harness, root, manager, settle } = await setup(policy);
    try {
      await manager.execute(
        { action: "spawn", name: "forbidden-parent", message: "work" },
        root.id,
        "forbidden-parent",
      );
      await root.configure({ model: policy.allowedModels[0]! }, context);
      await manager.execute(
        { action: "spawn", name: "unavailable-parent", message: "work" },
        root.id,
        "unavailable-parent",
      );
      await settle();
      expect((await manager.list()).map((child) => child.model)).toEqual([fallback, fallback]);
      await expect(
        manager.execute(
          { action: "spawn", message: "work", model: policy.allowedModels[0]! },
          root.id,
          "explicit-unavailable",
        ),
      ).rejects.toThrow("候选模型");
    } finally {
      await harness.close(context);
    }
  });
  it("prefers the allowed parent model over other enabled models", async () => {
    const parent = { provider: "faux", modelId: "faux-1" };
    const { harness, root, manager, settle } = await setup({
      ...defaultSubagentSettings,
      allowedModels: [{ provider: "faux", modelId: "faux-2" }, parent],
    });
    try {
      await manager.execute({ action: "spawn", message: "work" }, root.id, "spawn");
      await settle();
      expect((await manager.list())[0]?.model).toEqual(parent);
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
    expect(childPath("/root/worker", "review", false, invalid)).toBe("/review");
    expect(childPath("/root/worker", "review", true, invalid)).toBe("/root/worker/review");
    expect(() => childPath("/root", "../bad", true, invalid)).toThrow();
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
      { action: "spawn", name: "parent", message: "research", canDelegate: true },
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
      { action: "spawn", name: "parent", message: "research", canDelegate: true },
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

it("lets the orchestrator yield while children work and wakes it once with their result", async () => {
  const { harness, root, manager, faux } = await setup({
    ...defaultSubagentSettings,
    mode: "orchestrator",
  });
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
              wait: false,
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
    expect((await input.wait(context)).status).toBe("done");
    expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
    expect((await manager.list())[0]?.status).toBe("running");
    expect(rootRequests).toBe(2);
    childAnswer.resolve(fauxAssistantMessage("13"));
    await expect.poll(async () => (await manager.list())[0]?.status).toBe("completed");
    await root.waitForIdle(context);
    expect(rootRequests).toBe(3);
    expect((await manager.list())[0]?.status).toBe("completed");
    expect(JSON.stringify((await root.context(context)).messages)).toContain("Final result: 13");
  } finally {
    childAnswer.resolve(fauxAssistantMessage("13"));
    await harness.close(context);
  }
});

it("keeps progress passive and preserves it when a working child is stopped", async () => {
  const { harness, root, manager, faux } = await setup();
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  let requests = 0;
  faux.setResponses([
    (_request, options) => {
      requests++;
      ready.resolve();
      options?.signal?.addEventListener(
        "abort",
        () => answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      return answer.promise;
    },
    () => {
      requests++;
      return fauxAssistantMessage("Work stopped; source needs verification");
    },
  ]);
  try {
    await manager.execute(
      { action: "spawn", name: "research", message: "research" },
      root.id,
      "spawn",
    );
    harness.resume();
    await ready.promise;
    const child = (await manager.list())[0]!;
    await manager.execute(
      { action: "update", message: "Found a government notice; verifying the source" },
      child.conversationId as typeof root.id,
      "progress",
    );
    await manager.execute(
      { action: "update", message: "Found a government notice; verifying the source" },
      child.conversationId as typeof root.id,
      "progress",
    );
    expect(requests).toBe(1);
    expect(
      JSON.stringify((await root.context(context)).messages).match(/Found a government notice/g),
    ).toHaveLength(1);
    await manager.execute({ action: "stop", path: child.path }, root.id, "stop");
    expect((await manager.list())[0]).toMatchObject({
      status: "stopped",
      progress: { message: "Found a government notice; verifying the source" },
    });
    await root.waitForIdle(context);
    expect(JSON.stringify((await root.context(context)).messages)).toContain("stopped");
  } finally {
    answer.resolve(fauxAssistantMessage("done"));
    await harness.close(context);
  }
});

it("steers a running child without creating another completion reporter", async () => {
  const { harness, root, manager, faux, settle } = await setup();
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  faux.setResponses([
    () => {
      ready.resolve();
      return answer.promise;
    },
    () => fauxAssistantMessage("Verified source and scope"),
    () => fauxAssistantMessage("Root synthesis"),
  ]);
  try {
    await manager.execute(
      { action: "spawn", name: "research", message: "research" },
      root.id,
      "spawn",
    );
    harness.resume();
    await ready.promise;
    await manager.execute(
      { action: "send", path: "/research", message: "Verify the source" },
      root.id,
      "steer",
    );
    await expect
      .poll(async () =>
        (await harness.inspect(context)).submissions.some(
          (receipt) => receipt.requestId === "subagent-steer:steer",
        ),
      )
      .toBe(true);
    expect(
      (await harness.inspect(context)).tasks.filter(
        (task) => task.record.kind === "eta.subagent-reporter",
      ),
    ).toHaveLength(1);
    answer.resolve(fauxAssistantMessage("Initial findings"));
    await settle();
    const messages = JSON.stringify((await root.context(context)).messages);
    expect(messages.match(/\[\/research completed\]/g)).toHaveLength(1);
    expect(messages).toContain("Verified source and scope");
    expect(messages).not.toContain("[/research completed] Initial findings");
  } finally {
    answer.resolve(fauxAssistantMessage("done"));
    await harness.close(context);
  }
});

it("times out or cancels waiting without stopping the child", async () => {
  const { harness, root, manager, faux } = await setup();
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  faux.setResponses([
    () => {
      ready.resolve();
      return answer.promise;
    },
    () => fauxAssistantMessage("root answer"),
  ]);
  try {
    await manager.execute({ action: "spawn", name: "worker", message: "work" }, root.id, "spawn");
    harness.resume();
    await ready.promise;
    expect(await manager.wait("/worker", root.id, 0, context)).toMatchObject({ status: "running" });
    const abort = new AbortController();
    const waiting = manager.wait("/worker", root.id, undefined, {
      ...context,
      abortSignal: abort.signal,
    });
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect((await manager.list())[0]?.status).toBe("running");
    answer.resolve(fauxAssistantMessage("Final worker result"));
    expect(await manager.wait("/worker", root.id, undefined, context)).toMatchObject({
      status: "completed",
      output: "Final worker result",
    });
  } finally {
    answer.resolve(fauxAssistantMessage("done"));
    await harness.close(context);
  }
});

it("gives workers progress tools and reserves nested delegation for explicit coordinators", async () => {
  const { harness, root, manager, settle } = await setup();
  try {
    await manager.execute({ action: "spawn", name: "worker", message: "work" }, root.id, "worker");
    await settle();
    const child = (await manager.list())[0]!;
    const conversation = (await harness.conversation(
      child.conversationId as typeof root.id,
      context,
    ))!;
    expect((await conversation.agent(context)).tools.map((tool) => tool.name)).toEqual([
      "agent_update",
    ]);
    await expect(
      manager.execute(
        { action: "spawn", name: "nested", message: "same work" },
        conversation.id,
        "nested",
      ),
    ).rejects.toThrow("委派权限");
    await expect(
      manager.execute(
        { action: "send", path: "/root", message: "report" },
        conversation.id,
        "parent",
      ),
    ).rejects.toThrow("下级");
    await manager.execute(
      { action: "send", path: child.path, message: "Verify the remaining source" },
      root.id,
      "tool:idle",
    );
    await settle();
    expect(JSON.stringify((await conversation.context(context)).messages)).toContain(
      "Agent steering from /root; this is not a new user request",
    );
  } finally {
    await harness.close(context);
  }
});

it("sends one timeout reminder and can rearm it without steering or cancelling work", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { harness, root, manager, faux } = await setup();
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  let requests = 0;
  faux.setResponses([
    () => {
      requests++;
      ready.resolve();
      return answer.promise;
    },
    () => {
      requests++;
      return fauxAssistantMessage("The research continues");
    },
    () => {
      requests++;
      return fauxAssistantMessage("Still verifying the source");
    },
    () => {
      requests++;
      return fauxAssistantMessage("Verified result");
    },
  ]);
  try {
    await manager.execute(
      { action: "spawn", name: "research", message: "research", wait: false, timeoutMs: 30000 },
      root.id,
      "spawn",
    );
    harness.resume();
    await ready.promise;
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    const first = (await harness.snapshot(SubagentsDoc, context))!.agents[0]!.timeoutTask!;
    await vi.advanceTimersByTimeAsync(30000);
    await harness.waitForTask(first, context);
    await root.waitForIdle(context);
    expect(requests).toBe(2);
    expect((await manager.list())[0]?.status).toBe("running");
    await manager.execute(
      { action: "send", path: "/research", timeoutMs: 30000 },
      root.id,
      "rearm",
    );
    const second = (await harness.snapshot(SubagentsDoc, context))!.agents[0]!.timeoutTask!;
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(30000);
    await harness.waitForTask(second, context);
    await root.waitForIdle(context);
    expect(requests).toBe(3);
    const inspection = await harness.inspect(context);
    expect(
      inspection.submissions.filter((receipt) => receipt.requestId?.startsWith("subagent-steer:")),
    ).toHaveLength(0);
    expect(
      JSON.stringify((await root.context(context)).messages).match(/\[\/research timeout\]/g),
    ).toHaveLength(2);
    answer.resolve(fauxAssistantMessage("Final verified result"));
    expect(await manager.wait("/research", root.id, undefined, context)).toMatchObject({
      status: "completed",
    });
  } finally {
    vi.useRealTimers();
    answer.resolve(fauxAssistantMessage("done"));
    await harness.close(context);
  }
});

it("keeps complete output in storage while paging large reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-subagent-output-"));
  let harness: Harness | undefined;
  try {
    const first = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context),
    );
    harness = first.harness;
    const output = "verified-source\n".repeat(2000);
    first.faux.setResponses([
      () => fauxAssistantMessage(output),
      () => fauxAssistantMessage("Summary"),
    ]);
    await first.manager.execute(
      { action: "spawn", name: "worker", message: "work" },
      first.root.id,
      "spawn",
    );
    await first.settle();
    expect((await first.manager.list())[0]).toMatchObject({
      output: output.slice(0, 16000),
      outputTruncated: true,
    });
    expect(JSON.stringify((await first.root.context(context)).messages)).toContain(
      "Report truncated",
    );
    await harness.close(context);
    const second = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context),
    );
    harness = second.harness;
    const page = JSON.parse(
      await second.manager.execute(
        { action: "output", path: "/worker", offset: 16000, limit: 1000 },
        second.root.id,
        "output",
      ),
    );
    expect(page).toMatchObject({
      output: output.slice(16000, 17000),
      total: output.length,
      nextOffset: 17000,
    });
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

it("recovers accepted steering before delivery without duplicating the request or final report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-subagent-steering-"));
  let harness: Harness | undefined;
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  try {
    const first = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context),
    );
    harness = first.harness;
    await first.manager.execute(
      { action: "spawn", name: "worker", message: "original assignment" },
      first.root.id,
      "spawn",
    );
    await first.manager.execute(
      { action: "send", path: "/worker", message: "Verify sources" },
      first.root.id,
      "tool:queued",
    );
    await harness.close(context);
    const second = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context),
    );
    harness = second.harness;
    const ready = Promise.withResolvers<void>();
    second.faux.setResponses([
      () => {
        ready.resolve();
        return answer.promise;
      },
      () => fauxAssistantMessage("Verified findings"),
      () => fauxAssistantMessage("Root summary"),
    ]);
    harness.resume();
    await ready.promise;
    await second.manager.execute(
      { action: "send", path: "/worker", message: "Verify sources" },
      second.root.id,
      "tool:queued",
    );
    await expect
      .poll(async () =>
        (await harness!.inspect(context)).submissions.some(
          (receipt) => receipt.requestId === "subagent-steer:tool:queued",
        ),
      )
      .toBe(true);
    answer.resolve(fauxAssistantMessage("Initial findings"));
    await second.settle();
    const child = (await second.manager.list())[0]!;
    expect(child.output).toBe("Verified findings");
    const conversation = (await harness.conversation(
      child.conversationId as typeof second.root.id,
      context,
    ))!;
    const messages = JSON.stringify((await conversation.context(context)).messages);
    expect(messages.match(/original assignment/g)).toHaveLength(1);
    expect(messages.match(/Verify sources/g)).toHaveLength(1);
    expect(messages).toContain("Agent steering from /root; this is not a new user request");
    expect(
      JSON.stringify((await second.root.context(context)).messages).match(
        /\[\/worker completed\]/g,
      ),
    ).toHaveLength(1);
  } finally {
    answer.resolve(fauxAssistantMessage("done"));
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains the original reminder deadline across reopening", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const started = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "eta-subagent-timeout-"));
  let harness: Harness | undefined;
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  try {
    const first = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context),
    );
    harness = first.harness;
    await first.manager.execute(
      { action: "spawn", name: "worker", message: "work", wait: false, timeoutMs: 30000 },
      first.root.id,
      "spawn",
    );
    const timer = (await harness.snapshot(SubagentsDoc, context))!.agents[0]!.timeoutTask!;
    await harness.close(context);
    vi.setSystemTime(started + 60000);
    const second = await setup(
      defaultSubagentSettings,
      await openNodeJsonlStorage(directory, context),
    );
    harness = second.harness;
    second.faux.setResponses(
      Array.from(
        { length: 5 },
        () => (request) =>
          request.messages.findLast((message) => message.role === "user")?.content === "work"
            ? answer.promise
            : fauxAssistantMessage("Still working"),
      ),
    );
    harness.resume();
    await harness.waitForTask(timer, context);
    await second.root.waitForIdle(context);
    expect(
      JSON.stringify((await second.root.context(context)).messages).match(/\[\/worker timeout\]/g),
    ).toHaveLength(1);
    expect((await second.manager.list())[0]?.status).toBe("running");
    answer.resolve(fauxAssistantMessage("Done"));
    await second.settle();
  } finally {
    vi.useRealTimers();
    answer.resolve(fauxAssistantMessage("done"));
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

it("stops active descendants without reviving their parent or discarding completed descendants", async () => {
  const { harness, root, manager, faux } = await setup();
  const parentReady = Promise.withResolvers<void>();
  const descendantReady = Promise.withResolvers<void>();
  const parentAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const descendantAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  let parentRequests = 0;
  faux.setResponses(
    Array.from({ length: 8 }, () => (request, options) => {
      const last = request.messages.findLast((message) => message.role === "user");
      if (last?.content === "parent-work" || last?.content === "descendant-work") {
        const parent = last.content === "parent-work";
        if (parent) parentRequests++;
        const answer = parent ? parentAnswer : descendantAnswer;
        (parent ? parentReady : descendantReady).resolve();
        options?.signal?.addEventListener(
          "abort",
          () => answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
        return answer.promise;
      }
      return fauxAssistantMessage("Work stopped; unfinished findings need verification");
    }),
  );
  try {
    await manager.execute(
      { action: "spawn", name: "parent", message: "parent-work", canDelegate: true },
      root.id,
      "parent",
    );
    harness.resume();
    await parentReady.promise;
    const parent = (await manager.list())[0]!;
    await manager.execute(
      { action: "spawn", name: "done", message: "finished-work" },
      parent.conversationId as typeof root.id,
      "done",
    );
    await manager.wait("/done", root.id, undefined, context);
    await manager.execute(
      { action: "spawn", name: "active", message: "descendant-work" },
      parent.conversationId as typeof root.id,
      "active",
    );
    await descendantReady.promise;
    await manager.execute({ action: "stop", path: "/parent" }, root.id, "stop");
    await root.waitForIdle(context);
    expect((await manager.list()).map((child) => child.status)).toEqual([
      "stopped",
      "completed",
      "stopped",
    ]);
    for (const child of await manager.list())
      expect(
        (await harness.snapshot(LiveDoc, child.conversationId as typeof root.id, context))?.run,
      ).toBeUndefined();
    expect(parentRequests).toBe(1);
    expect(
      JSON.stringify((await root.context(context)).messages).match(/\[\/parent stopped\]/g),
    ).toHaveLength(1);
  } finally {
    parentAnswer.resolve(fauxAssistantMessage("done"));
    descendantAnswer.resolve(fauxAssistantMessage("done"));
    await harness.close(context);
  }
});

it("stops live descendant conversations after their reporters are aborted and keeps completed siblings", async () => {
  const { harness, root, manager, settle, faux } = await setup();
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  try {
    await manager.execute({ action: "spawn", name: "done", message: "finish" }, root.id, "done");
    await settle();
    faux.setResponses([
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
    await manager.execute(
      { action: "spawn", name: "parent", message: "work", canDelegate: true },
      root.id,
      "parent",
    );
    await ready.promise;
    const parent = (await manager.list()).find((child) => child.path === "/parent")!;
    await manager.execute(
      { action: "spawn", name: "queued", message: "more work" },
      parent.conversationId as typeof root.id,
      "queued",
    );
    await manager.stopAll();
    expect((await manager.list()).map((child) => child.status)).toEqual([
      "completed",
      "stopped",
      "stopped",
    ]);
    for (const child of await manager.list())
      expect(
        (await harness.snapshot(LiveDoc, child.conversationId as typeof root.id, context))?.run,
      ).toBeUndefined();
    expect((await harness.inspect(context)).tasks).toHaveLength(0);
  } finally {
    answer.resolve(fauxAssistantMessage("done"));
    await harness.close(context);
  }
});

it("returns phase-aware output and reports it once while retaining the child's signed history", async () => {
  const { harness, root, manager, settle, faux } = await setup();
  const text = "1+1 = 2。";
  const parts = (["commentary", "final_answer"] as const).map((phase) => ({
    type: "text" as const,
    text,
    textSignature: JSON.stringify({ v: 1, id: `answer-${phase}`, phase }),
  }));
  faux.setResponses([
    () => fauxAssistantMessage(parts),
    () => fauxAssistantMessage("Summary: 1+1 = 2。"),
  ]);
  try {
    await manager.execute(
      { action: "spawn", name: "addition", message: "Compute 1+1" },
      root.id,
      "spawn",
    );
    await settle();
    const child = (await manager.list())[0]!;
    expect(child.output).toBe(text);
    const output = JSON.parse(
      await manager.execute({ action: "output", path: child.path }, root.id, "output"),
    );
    expect(output.output).toBe(text);
    const parentMessages = (await root.context(context)).messages;
    const reports = parentMessages.filter(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith("[/addition completed]"),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.content).toContain(
      `[/addition completed] ${text}\n\nThis is a subagent report`,
    );
    const conversation = (await harness.conversation(
      child.conversationId as typeof root.id,
      context,
    ))!;
    const answer = (await conversation.context(context)).messages.find(
      (message) => message.role === "assistant",
    );
    expect(answer?.content).toEqual(parts);
  } finally {
    await harness.close(context);
  }
});
