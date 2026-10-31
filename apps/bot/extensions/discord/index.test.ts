import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createBotApplication } from "../../src/application.ts";
import type { BotApplication } from "../../src/application.ts";
import type { BotConfig } from "../../src/config.ts";
import type { DiscordMessage, DiscordPort } from "./types.ts";
import { PhaseLog } from "./fixtures/phases.ts";
import { DeliveryError } from "./types.ts";
import { DiscordExtension } from "./index.ts";
import { DiscordStore } from "./store.ts";

const applications: BotApplication[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function message(
  id: string,
  content = "issue: investigate",
  channelId = "10",
  bot = false,
  authorId = bot ? "99" : "20",
): DiscordMessage {
  return {
    id,
    content,
    channelId,
    guildId: "1",
    authorId,
    bot,
    createdAt: Number(id),
  };
}
class FakeDiscord implements DiscordPort {
  online = false;
  handlers: Parameters<DiscordPort["start"]>[0] | undefined;
  readonly messages = new Map<string, DiscordMessage[]>();
  readonly archived = new Map<string, boolean>();
  sendCalls = 0;
  ensureCalls = 0;
  failure: Error | undefined;
  acceptThenFail = false;
  private nextId = 10000;
  async start(handlers: Parameters<DiscordPort["start"]>[0]) {
    this.handlers = handlers;
    this.online = true;
  }
  async stop() {
    this.online = false;
    this.handlers = undefined;
  }
  connected() {
    return this.online;
  }
  async ensureThread(source: DiscordMessage) {
    this.ensureCalls++;
    return source.id;
  }
  async history(channelId: string, options: Parameters<DiscordPort["history"]>[1]) {
    return (this.messages.get(channelId) ?? [])
      .filter(
        (row) =>
          (!options.after || BigInt(row.id) > BigInt(options.after)) &&
          (!options.before || BigInt(row.id) < BigInt(options.before)),
      )
      .toSorted((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
      .slice(0, options.limit);
  }
  async send(threadId: string, content: string) {
    this.sendCalls++;
    const failure = this.failure;
    this.failure = undefined;
    if (failure && !this.acceptThenFail) throw failure;
    const id = String(this.nextId++);
    const row = message(id, content, threadId, true);
    this.messages.set(threadId, [...(this.messages.get(threadId) ?? []), row]);
    await this.handlers?.message(row);
    if (failure) throw failure;
    return id;
  }
  async findDelivery(threadId: string, marker: string) {
    return this.messages.get(threadId)?.find((row) => row.bot && row.content.includes(marker))?.id;
  }
  async archive(threadId: string, archived: boolean) {
    this.archived.set(threadId, archived);
  }
  async emit(row: DiscordMessage) {
    this.messages.set(row.channelId, [...(this.messages.get(row.channelId) ?? []), row]);
    await this.handlers?.message(row);
  }
}
async function fixture(options: { allowedAuthorIds?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "eta-discord-"));
  roots.push(root);
  const cwd = join(root, "workspaces", "workspace");
  await mkdir(cwd, { recursive: true });
  const provider = fauxProvider({
    provider: "discord-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "discord-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const models = createModels();
  models.setProvider({
    ...provider.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? titles.provider.streamSimple(model, context, options)
        : provider.provider.streamSimple(model, context, options),
  });
  const port = new FakeDiscord();
  const config: BotConfig = {
    dataRoot: join(root, "data"),
    adminToken: "test-admin",
    shutdownGraceMs: 0,
    workspaceRoot: join(root, "workspaces"),
    projects: [{ key: "test", rootPath: cwd }],
    runtime: { defaultThinkingLevel: "off" },
    discord: {
      tokenEnv: "DISCORD_TEST_TOKEN",
      channels: [
        {
          guildId: "1",
          channelId: "10",
          projectKey: "test",
          triggerPrefix: "issue:",
          startAfter: "0",
          ...(options.allowedAuthorIds ? { allowedAuthorIds: options.allowedAuthorIds } : {}),
        },
      ],
    },
  };
  const open = async (override: Partial<BotConfig> = {}) => {
    const app = await createBotApplication(
      { ...config, ...override },
      { models, discordPort: port },
    );
    applications.push(app);
    return app;
  };
  const app = await open();
  const finished = (app: BotApplication, id: string) =>
    expect.poll(() => app.discord!.store.input(id)?.state, { timeout: 5000 }).toBe("done");
  return { app, open, port, provider, cwd, config, finished };
}

test("Gateway filtering and deduplication create one issue, run a real tool and reuse its thread", async () => {
  const { app, port, provider, cwd, finished } = await fixture();
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'text(await tools.write({path:"discord-proof.txt",content:"Discord investigation"}));',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Investigation complete"),
    fauxAssistantMessage("Followup complete"),
  ]);
  await port.emit(message("100", "ordinary chatter"));
  await port.emit(message("101", "issue: bot output", "10", true));
  await port.emit(message("102"));
  await port.emit(message("102"));
  await finished(app, "102");
  expect(await readFile(join(cwd, "discord-proof.txt"), "utf8")).toBe("Discord investigation");
  const issue = app.discord!.store.issue("102")!;
  expect((await app.core.openThread(issue.etaThreadId!)).snapshot.configuration.agentMode).toBe(
    "codemode",
  );
  expect(await app.core.threads()).toHaveLength(1);
  expect(port.ensureCalls).toBe(1);
  await port.emit(message("103", "Additional detail", issue.discordThreadId!));
  await finished(app, "103");
  expect(app.discord!.store.inputs()).toHaveLength(2);
  expect(
    (await app.core.openThread(issue.etaThreadId!)).snapshot.transcript.filter(
      ({ message }) => message.role === "user",
    ),
  ).toHaveLength(2);
  expect(port.sendCalls).toBe(2);
  expect(app.discord!.store.issue("102")?.state).toBe("waiting");
  expect((await app.app.request("/v1/extensions/discord")).status).toBe(401);
});

test("followups received while an investigation runs wait in a durable issue queue", async () => {
  const { app, port, provider, finished } = await fixture();
  const waiting = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  provider.setResponses([
    (_context, options) => {
      options?.signal?.addEventListener(
        "abort",
        () => waiting.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      return waiting.promise;
    },
    fauxAssistantMessage("Second input handled"),
  ]);
  await port.emit(message("200"));
  await port.emit(message("201", "Followup while running", "200"));
  expect(app.discord!.store.input("201")?.state).toBe("queued");
  waiting.resolve(fauxAssistantMessage("First input handled"));
  await finished(app, "200");
  await finished(app, "201");
  expect(port.sendCalls).toBe(2);
});

test("restart after remote acceptance reconciles a reply without posting it twice", async () => {
  const { app, open, port, provider, finished } = await fixture();
  provider.setResponses([fauxAssistantMessage("One reply")]);
  port.failure = new Error("Response lost after acceptance");
  port.acceptThenFail = true;
  await port.emit(message("300"));
  await expect.poll(() => app.discord!.store.outputs()[0]?.state).toBe("sending");
  await app.close();
  const restored = await open();
  await finished(restored, "300");
  expect(port.sendCalls).toBe(1);
  expect(restored.discord!.store.outputs()[0]).toMatchObject({ state: "sent", remoteId: "10000" });
  expect(await restored.core.threads()).toHaveLength(1);
});

test("an unconfirmed delivery waits for review and an explicit retry", async () => {
  const { app, port, provider, finished } = await fixture();
  provider.setResponses([fauxAssistantMessage("Review this delivery")]);
  port.failure = new Error("Unknown outcome");
  await port.emit(message("400"));
  await expect.poll(() => app.discord!.store.outputs()[0]?.state, { timeout: 5000 }).toBe("review");
  expect(port.sendCalls).toBe(1);
  expect(app.discord!.store.issue("400")?.state).toBe("review");
  await app.discord!.retryDelivery(app.discord!.store.outputs()[0]!.id);
  await finished(app, "400");
  expect(port.sendCalls).toBe(2);
});

test("a known transient rejection retries through the durable task", async () => {
  const { app, port, provider, finished } = await fixture();
  provider.setResponses([fauxAssistantMessage("Retry reply")]);
  port.failure = new DeliveryError(true);
  await port.emit(message("500"));
  await finished(app, "500");
  expect(port.sendCalls).toBe(2);
});

test("closing and reopening business state preserves the Core thread", async () => {
  const { app, port, provider, finished } = await fixture();
  provider.setResponses([fauxAssistantMessage("Initial"), fauxAssistantMessage("Reopened")]);
  await port.emit(message("600"));
  await finished(app, "600");
  const id = app.discord!.store.issue("600")!.etaThreadId;
  await app.discord!.control("600", "close");
  expect(port.archived.get("600")).toBe(true);
  await port.emit(message("601", "Ignored while closed", "600"));
  expect(app.discord!.store.input("601")).toBeUndefined();
  expect((await app.core.threads())[0]?.archivedAt).toBeUndefined();
  await app.discord!.control("600", "reopen");
  expect(port.archived.get("600")).toBe(false);
  await port.emit(message("602", "Continue after reopen", "600"));
  await finished(app, "602");
  expect(app.discord!.store.issue("600")?.etaThreadId).toBe(id);
});

test("disabled reception retains pending task definitions until reenabled", async () => {
  const { app, open, port, provider, config, finished } = await fixture();
  provider.setResponses([fauxAssistantMessage("Preserved reply")]);
  port.failure = new DeliveryError(true);
  await port.emit(message("700"));
  await expect.poll(() => app.discord!.store.outputs()[0]?.state).toBe("pending");
  await app.close();
  const disabled = await open({ discord: { ...config.discord!, enabled: false } });
  const issue = disabled.discord!.store.issue("700")!;
  expect(await disabled.core.recovery(issue.etaThreadId!)).toMatchObject({ blockedTasks: [] });
  expect(disabled.discord!.status().accepting).toBe(false);
  await disabled.close();
  const restored = await open();
  await finished(restored, "700");
  expect(port.sendCalls).toBe(2);
});

test("gap backfill deduplicates inbox and advances only after reaching its prior cursor", async () => {
  const { app, port, provider } = await fixture();
  provider.setResponses([
    fauxAssistantMessage("A"),
    fauxAssistantMessage("B"),
    fauxAssistantMessage("C"),
  ]);
  await port.emit(message("800"));
  port.messages.set("10", [...port.messages.get("10")!, message("801"), message("802")]);
  await app.discord!.backfill();
  expect(app.discord!.store.inputs().map((input) => input.id)).toEqual(["800", "801", "802"]);
  await app.discord!.backfill();
  expect(app.discord!.store.inputs()).toHaveLength(3);
  expect(app.discord!.store.cursor("10")).toBe("802");
});

test("a faulted reply task is visible and can resume from the same model receipt", async () => {
  const { app, port, provider, finished } = await fixture();
  provider.setResponses([fauxAssistantMessage("Result retained through task failure")]);
  const output = app.discord!.store.output.bind(app.discord!.store);
  let fail = true;
  app.discord!.store.output = (record) => {
    if (fail) {
      fail = false;
      throw new Error("Temporary persistence failure");
    }
    output(record);
  };
  await port.emit(message("900"));
  await expect.poll(() => app.discord!.store.input("900")?.state).toBe("blocked");
  const operation = app.discord!.store.input("900")!.operationId;
  await app.discord!.control("900", "resume");
  await finished(app, "900");
  expect(app.discord!.store.input("900")).toMatchObject({ operationId: operation, taskAttempt: 1 });
  expect(port.sendCalls).toBe(1);
  const issue = app.discord!.store.issue("900")!;
  expect(
    (await app.core.openThread(issue.etaThreadId!)).snapshot.transcript.filter(
      ({ message }) => message.role === "user",
    ),
  ).toHaveLength(1);
});

test("an incomplete bounded scan reports the gap and can recover after increasing the limit", async () => {
  const { app, open, port, provider, config, finished } = await fixture();
  await app.close();
  provider.setResponses([
    fauxAssistantMessage("A"),
    fauxAssistantMessage("B"),
    fauxAssistantMessage("C"),
  ]);
  port.messages.set("10", [message("1000"), message("1001"), message("1002")]);
  const bounded = await open({ discord: { ...config.discord!, backfillLimit: 2 } });
  expect(bounded.discord!.status().limitedBackfill).toContain("10");
  expect(bounded.discord!.store.cursor("10")).toBe("0");
  expect(bounded.discord!.store.inputs()).toHaveLength(2);
  await bounded.close();
  const restored = await open({ discord: { ...config.discord!, backfillLimit: 10 } });
  expect(restored.discord!.store.inputs()).toHaveLength(3);
  expect(restored.discord!.store.cursor("10")).toBe("1002");
  expect(restored.discord!.status().limitedBackfill).not.toContain("10");
  for (const id of ["1000", "1001", "1002"]) await finished(restored, id);
});

// The healthy path measures about 2.7s locally (fixture + real directory copy + reopen + redelivery),
// so the implicit 5s default leaves little room on a loaded CI runner. Phases are reported if the
// budget would expire, so a future failure shows which stage consumed the time.
test("restoring a stopped data-directory backup preserves association, queue and pending delivery", async () => {
  const phases = new PhaseLog(20_000);
  try {
    const { app, open, port, provider, config, finished } = await fixture();
    phases.phase("fixture");
    provider.setResponses([fauxAssistantMessage("Restored delivery")]);
    port.failure = new DeliveryError(true);
    await port.emit(message("1100"));
    await expect.poll(() => app.discord!.store.outputs()[0]?.state).toBe("pending");
    const issue = app.discord!.store.issue("1100")!;
    phases.phase("stop");
    await app.close();
    const backup = `${config.dataRoot}-backup`;
    phases.phase("backup");
    await cp(config.dataRoot, backup, { recursive: true });
    await rm(config.dataRoot, { recursive: true });
    await cp(backup, config.dataRoot, { recursive: true });
    phases.phase("reopen");
    const restored = await open();
    phases.phase("redeliver");
    await finished(restored, "1100");
    expect(restored.discord!.store.issue("1100")?.etaThreadId).toBe(issue.etaThreadId);
    expect(restored.discord!.store.inputs()).toHaveLength(1);
    expect(restored.discord!.store.outputs()).toHaveLength(1);
    expect(port.sendCalls).toBe(2);
  } catch (error) {
    phases.failed(20_000);
    throw error;
  } finally {
    phases.stop();
  }
}, 20_000);

test("an operator allowlist narrows who may drive a run", async () => {
  const allowed = await fixture({ allowedAuthorIds: ["20"] });
  await allowed.port.emit(message("300", "issue: allowed", "10", false, "20"));
  await allowed.finished(allowed.app, "300");
  expect(allowed.port.sendCalls).toBe(1);
  await allowed.port.emit(message("301", "issue: outsider", "10", false, "21"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(allowed.app.discord!.store.issue("301")).toBeUndefined();
  expect(allowed.app.discord!.store.input("301")).toBeUndefined();
  expect(allowed.port.sendCalls).toBe(1);
});

test("without an allowlist every participant is still accepted", async () => {
  const open = await fixture();
  await open.port.emit(message("310", "issue: from anyone", "10", false, "21"));
  await open.finished(open.app, "310");
  expect(open.port.sendCalls).toBe(1);
});

test("the allowlist also covers followups posted in an issue thread", async () => {
  const scoped = await fixture({ allowedAuthorIds: ["20"] });
  await scoped.port.emit(message("320", "issue: first", "10", false, "20"));
  await scoped.finished(scoped.app, "320");
  const threadId = scoped.app.discord!.store.issue("320")!.discordThreadId!;
  await scoped.port.emit(message("321", "outsider followup", threadId, false, "21"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(scoped.app.discord!.store.input("321")).toBeUndefined();
  await scoped.port.emit(message("322", "allowed followup", threadId, false, "20"));
  await expect.poll(() => scoped.app.discord!.store.input("322")?.state).toBeDefined();
});

test.each([false, true])(
  "Discord close releases actual SQLite when transport stop fails=%s",
  async (fails) => {
    const root = await mkdtemp(join(tmpdir(), "eta-discord-close-"));
    roots.push(root);
    const path = join(root, "discord.sqlite");
    const seed = new DiscordStore(path);
    seed.advance("10", "100");
    seed.close();
    const port = new FakeDiscord();
    const stop = port.stop.bind(port);
    const failure = new Error("Transport cleanup failed");
    if (fails)
      port.stop = async () => {
        throw failure;
      };
    const extension = new DiscordExtension(
      { tokenEnv: "UNUSED_TEST_TOKEN", channels: [] },
      path,
      port,
    );
    try {
      expect(extension.status().issues).toEqual([]);
      if (fails) await expect(extension.close()).rejects.toBe(failure);
      else await extension.close();
      // status performs real SQLite reads: a closed handle, not a callback count, is the postcondition.
      expect(() => extension.status()).toThrow(/not open|closed/i);
      const reopened = new DiscordStore(path);
      try {
        expect(reopened.cursor("10")).toBe("100");
      } finally {
        reopened.close();
      }
    } finally {
      // Only after the assertions: let the old implementation release its leaked handle too.
      port.stop = stop;
      await extension.close().catch(() => {});
    }
  },
);

test("Bot releases Discord storage and its data-root lock when transport stop rejects", async () => {
  const { app, port, open } = await fixture();
  const stop = port.stop.bind(port);
  const cursor = app.discord!.store.cursor("10");
  expect(cursor).toBeDefined();
  port.stop = async () => {
    throw new Error("Transport cleanup failed");
  };
  // Application.close coalesces its rejected result; cleanup must not ask afterEach to rethrow it.
  applications.splice(applications.indexOf(app), 1);
  try {
    await expect(app.close()).rejects.toThrow("An extension could not release its resources.");
    expect(() => app.discord!.store.cursor("10")).toThrow(/not open|closed/i);
    port.stop = stop;
    await stop();
    const reopened = await open();
    expect(reopened.discord!.store.cursor("10")).toBe(cursor);
    expect(reopened.discord!.status().connected).toBe(true);
  } finally {
    port.stop = stop;
    await stop();
    await app.discord!.close().catch(() => {});
  }
});

test.each(["close", "stop", "close-then-stop", "peer"] as const)(
  "a late resume inspection respects newer %s controls",
  async (action) => {
    const { app, port, provider, finished } = await fixture();
    provider.setResponses([
      fauxAssistantMessage("Initial reply"),
      fauxAssistantMessage("Must not run"),
    ]);
    await port.emit(message("102"));
    await finished(app, "102");
    if (action === "peer") {
      await port.emit(message("202"));
      await finished(app, "202");
    }
    await app.discord!.control("102", "stop");
    const issue = app.discord!.store.issue("102")!;
    const original = app.core.recovery;
    const release = Promise.withResolvers<void>();
    let entered = false;
    let hold = true;
    const inspecting = vi.spyOn(app.core, "recovery").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === issue.etaThreadId && hold) {
        hold = false;
        entered = true;
        await release.promise;
      }
      return result;
    });
    const resuming = app.discord!.control("102", "resume");
    try {
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      if (action === "peer") await app.discord!.control("202", "close");
      else {
        await app.discord!.control("102", action === "stop" ? "stop" : "close");
        if (action === "close-then-stop") await app.discord!.control("102", "stop");
      }
      const expected = action === "close" ? "closed" : "stopped";
      expect(app.discord!.store.issue("102")?.state).toBe(expected);
      release.resolve();
      await resuming;
      const state = app.discord!.store.issue("102")?.state;
      await port.emit(message("103", "Followup after close", issue.discordThreadId!));
      expect({
        state,
        accepted: app.discord!.store.input("103") !== undefined,
      }).toEqual({ state: action === "peer" ? "waiting" : expected, accepted: action === "peer" });
      if (action === "peer") await finished(app, "103");
    } finally {
      release.resolve();
      await resuming.catch(() => {});
      inspecting.mockRestore();
    }
  },
  15000,
);

test.each(["stop", "close"] as const)(
  "late %s cleanup cannot cancel work admitted by a newer reopen",
  async (action) => {
    const { app, port, provider, finished } = await fixture();
    provider.setResponses([fauxAssistantMessage("Initial reply")]);
    await port.emit(message("102"));
    await finished(app, "102");
    const issue = app.discord!.store.issue("102")!;
    const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    let started = false;
    provider.setResponses([
      (_context, options) => {
        started = true;
        options?.signal?.addEventListener(
          "abort",
          () => answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
        return answer.promise;
      },
    ]);
    const original = app.controller.stop.bind(app.controller);
    const release = Promise.withResolvers<void>();
    let entered = false;
    let hold = true;
    const stoppingCore = vi.spyOn(app.controller, "stop").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === issue.etaThreadId && hold) {
        hold = false;
        entered = true;
        await release.promise;
      }
      return result;
    });
    const stopping = app.discord!.control("102", action);
    try {
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      await app.discord!.control("102", "reopen");
      await port.emit(message("103", "Replacement work", issue.discordThreadId!));
      await expect.poll(() => started, { timeout: 5000 }).toBe(true);
      const input = app.discord!.store.input("103")!;
      expect(input.state).toBe("admitted");
      expect((await app.core.operation(issue.etaThreadId!, input.operationId!)).status).toBe(
        "running",
      );
      release.resolve();
      await stopping;
      const state = app.discord!.store.input("103")?.state;
      const operation = (await app.core.operation(issue.etaThreadId!, input.operationId!)).status;
      port.failure = new DeliveryError(false);
      answer.resolve(fauxAssistantMessage("Replacement reply"));
      await expect
        .poll(() => app.discord!.store.outputs("103")[0]?.state, { timeout: 5000 })
        .toBe("failed");
      const delivery = app.discord!.store.outputs("103")[0]!;
      const retry = await app.discord!.retryDelivery(delivery.id).then(
        () => "accepted",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect({ state, operation, retry }).toEqual({
        state: "admitted",
        operation: "running",
        retry: "accepted",
      });
      await finished(app, "103");
    } finally {
      release.resolve();
      answer.resolve(fauxAssistantMessage("Cleanup"));
      await stopping.catch(() => {});
      stoppingCore.mockRestore();
    }
  },
  15000,
);

test.each(["new-fails", "old-fails", "new-stop", "peer", "pending-new"] as const)(
  "archive acknowledgements respect %s ownership",
  async (scenario) => {
    const { app, port, provider, finished } = await fixture();
    provider.setResponses([fauxAssistantMessage("Initial reply")]);
    await port.emit(message("102"));
    await finished(app, "102");
    if (scenario === "peer") {
      await port.emit(message("202"));
      await finished(app, "202");
    }
    // Administrative controls remain available while ingress is paused; avoid unrelated pump retries.
    await app.discord!.stopIngress();
    const issue = app.discord!.store.issue("102")!;
    const archive = port.archive.bind(port);
    const release = Promise.withResolvers<void>();
    const releaseNew = Promise.withResolvers<void>();
    let newEntered = false;
    let newer: Promise<unknown> | undefined;
    let entered = false;
    let first = true;
    port.archive = async (id, archived) => {
      if (id === issue.discordThreadId && first) {
        first = false;
        await archive(id, archived);
        entered = true;
        await release.promise;
        if (scenario === "old-fails" || scenario === "new-stop")
          throw new Error("Old response failed");
        return;
      }
      if (scenario === "new-fails" && id === issue.discordThreadId)
        throw new Error("New archive failed");
      await archive(id, archived);
      if (scenario === "pending-new" && id === issue.discordThreadId) {
        newEntered = true;
        await releaseNew.promise;
      }
    };
    const older = app.discord!.control("102", "close").then(
      () => "ok",
      () => "failed",
    );
    try {
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      if (scenario === "pending-new") {
        newer = app.discord!.control("102", "reopen");
        await expect.poll(() => newEntered, { timeout: 5000 }).toBe(true);
      } else if (scenario === "new-fails")
        await expect(app.discord!.control("102", "reopen")).rejects.toThrow();
      else if (scenario === "new-stop") await app.discord!.control("102", "stop");
      else if (scenario === "peer") await app.discord!.control("202", "stop");
      else await app.discord!.control("102", "reopen");
      const latest = app.discord!.store.issue("102")!;
      if (scenario === "new-fails") {
        expect(latest.archivePending).toBe(true);
        expect(latest.error).not.toBeNull();
      }
      if (scenario === "old-fails" || scenario === "new-stop") {
        expect(latest.archivePending).toBe(false);
        expect(latest.error).toBeNull();
      }
      release.resolve();
      expect(await older).toBe(
        scenario === "old-fails" || scenario === "new-stop" ? "failed" : "ok",
      );
      if (scenario === "pending-new") {
        releaseNew.resolve();
        await newer;
      }
      const current = app.discord!.store.issue("102")!;
      expect({
        state: current.state,
        archivePending: current.archivePending,
        error: current.error,
      }).toEqual(
        scenario === "peer" || scenario === "pending-new"
          ? {
              state: scenario === "peer" ? "closed" : "waiting",
              archivePending: false,
              error: null,
            }
          : { state: latest.state, archivePending: latest.archivePending, error: latest.error },
      );
      expect(port.archived.get(issue.discordThreadId!)).toBe(
        scenario !== "old-fails" && scenario !== "pending-new",
      );
    } finally {
      release.resolve();
      releaseNew.resolve();
      await older;
      await newer?.catch(() => {});
      port.archive = archive;
    }
  },
  15000,
);

test.each(["stop", "close", "stop-reopen", "sent", "peer", "unchanged"])(
  "a delayed manual delivery retry respects newer %s state",
  async (scenario) => {
    const { app, port, provider, finished } = await fixture();
    provider.setResponses([fauxAssistantMessage("Retry this reply")]);
    port.failure = new DeliveryError(false);
    await port.emit(message("102"));
    await expect
      .poll(() => app.discord!.store.outputs()[0]?.state, { timeout: 5000 })
      .toBe("failed");
    const record = app.discord!.store.outputs()[0]!;
    const input = app.discord!.store.input("102")!;
    const issue = app.discord!.store.issue("102")!;
    if (scenario === "peer") {
      provider.setResponses([fauxAssistantMessage("Peer reply")]);
      await port.emit(message("202"));
      await expect.poll(() => app.discord!.store.issue("202")?.etaThreadId).toBeTruthy();
    }
    const find = port.findDelivery.bind(port);
    const release = Promise.withResolvers<void>();
    let entered = false;
    port.findDelivery = async (threadId, marker) => {
      const result = await find(threadId, marker);
      if (!entered && marker === record.marker) {
        entered = true;
        await release.promise;
      }
      return result;
    };
    const older = Promise.resolve(
      app.app.request("/v1/extensions/discord/deliveries/" + record.id + "/retry", {
        method: "POST",
        headers: { authorization: "Bearer test-admin" },
      }),
    );
    try {
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      if (scenario === "sent") {
        await app.discord!.retryDelivery(record.id);
        await finished(app, "102");
        await expect
          .poll(async () => (await app.core.task(issue.etaThreadId!, input.taskId!)).state, {
            timeout: 5000,
          })
          .toMatchObject({ status: "terminal", outcome: { status: "completed" } });
      } else if (scenario !== "unchanged") {
        await app.discord!.control(
          scenario === "peer" ? "202" : "102",
          scenario === "close" ? "close" : "stop",
        );
        if (scenario === "stop-reopen") await app.discord!.control("102", "reopen");
      }
      const before = app.discord!.store.delivery(record.id)!;
      const cancelled = ["stop", "close", "stop-reopen"].includes(scenario);
      if (cancelled) {
        expect((await app.core.task(issue.etaThreadId!, input.taskId!)).state).toMatchObject({
          status: "terminal",
          outcome: { status: "aborted" },
        });
        expect(app.discord!.store.input("102")?.state).toBe("cancelled");
        expect(before.state).toBe("failed");
      }
      release.resolve();
      const response = await older;
      expect(response.status).toBe(cancelled ? 409 : 200);
      if (cancelled) {
        expect(await response.json()).toMatchObject({ error: { code: "IssueStopped" } });
        expect(app.discord!.store.input("102")?.state).toBe("cancelled");
        expect(app.discord!.store.delivery(record.id)).toEqual(before);
        await expect(app.discord!.retryDelivery(record.id)).rejects.toMatchObject({
          code: "IssueStopped",
        });
        expect(await find(record.threadId, record.marker)).toBeUndefined();
      } else {
        await finished(app, "102");
        const current = app.discord!.store.delivery(record.id)!;
        expect(current).toMatchObject({ state: "sent", error: null });
        expect(await find(record.threadId, record.marker)).toBe(current.remoteId);
        expect(port.messages.get(record.threadId)).toHaveLength(1);
        if (scenario === "sent") {
          expect(current).toEqual(before);
          expect(await response.json()).toEqual(before);
        }
      }
    } finally {
      release.resolve();
      await older;
      port.findDelivery = find;
    }
  },
);

test.each(["stop", "close", "replacement", "peer", "unchanged"])(
  "a late blocked-task inspection respects newer %s control",
  async (scenario) => {
    const { app, port, provider, finished } = await fixture();
    provider.setResponses([fauxAssistantMessage("Retained model result")]);
    const output = app.discord!.store.output.bind(app.discord!.store);
    let fail = true;
    app.discord!.store.output = (record) => {
      if (fail) {
        fail = false;
        throw new Error("Temporary output persistence failure");
      }
      output(record);
    };
    await port.emit(message("102"));
    await expect
      .poll(() => app.discord!.store.input("102")?.state, { timeout: 5000 })
      .toBe("blocked");
    app.discord!.store.output = output;
    const issue = app.discord!.store.issue("102")!;
    const input = app.discord!.store.input("102")!;
    expect((await app.core.task(issue.etaThreadId!, input.taskId!)).state).toMatchObject({
      status: "terminal",
      outcome: { status: "faulted" },
    });
    if (scenario === "peer") {
      await port.emit(message("202"));
      await expect.poll(() => app.discord!.store.issue("202")?.etaThreadId).toBeTruthy();
    }
    const inspect = app.core.task.bind(app.core);
    const release = Promise.withResolvers<void>();
    let entered = false;
    app.core.task = async (threadId, taskId) => {
      const result = await inspect(threadId, taskId);
      if (!entered && threadId === issue.etaThreadId && taskId === input.taskId) {
        entered = true;
        await release.promise;
      }
      return result;
    };
    const action = scenario === "close" ? "reopen" : "resume";
    const older = Promise.resolve(
      app.app.request("/v1/extensions/discord/issues/102/" + action, {
        method: "POST",
        headers: { authorization: "Bearer test-admin" },
      }),
    );
    try {
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      if (scenario === "replacement") {
        await app.discord!.control("102", "resume");
        await finished(app, "102");
        const replacement = app.discord!.store.input("102")!;
        expect(replacement.taskId).not.toBe(input.taskId);
        await expect
          .poll(() => inspect(issue.etaThreadId!, replacement.taskId!).then((task) => task.state), {
            timeout: 5000,
          })
          .toMatchObject({ status: "terminal", outcome: { status: "completed" } });
      } else if (scenario !== "unchanged") {
        await app.discord!.control(
          scenario === "peer" ? "202" : "102",
          scenario === "close" ? "close" : "stop",
        );
      }
      const before = app.discord!.store.input("102")!;
      if (scenario === "stop" || scenario === "close") expect(before.state).toBe("cancelled");
      release.resolve();
      expect((await older).status).toBe(200);
      if (["stop", "close", "replacement"].includes(scenario))
        expect(app.discord!.store.input("102")).toEqual(before);
      if (scenario === "stop" || scenario === "close") {
        expect(app.discord!.store.issue("102")?.state).toBe(
          scenario === "close" ? "closed" : "stopped",
        );
        expect(app.discord!.store.outputs("102")).toEqual([]);
      } else {
        await finished(app, "102");
        expect(app.discord!.store.input("102")).toMatchObject({
          operationId: input.operationId,
          taskAttempt: 1,
        });
        const record = app.discord!.store.outputs("102")[0]!;
        expect(record.state).toBe("sent");
        expect(await port.findDelivery(record.threadId, record.marker)).toBe(record.remoteId);
        if (scenario === "replacement") {
          provider.setResponses([fauxAssistantMessage("Followup after replacement")]);
          await port.emit(message("103", "Followup", issue.discordThreadId!));
          await finished(app, "103");
        }
        expect(
          (await app.core.openThread(issue.etaThreadId!)).snapshot.transcript.filter(
            ({ message }) => message.role === "user",
          ),
        ).toHaveLength(scenario === "replacement" ? 2 : 1);
      }
    } finally {
      release.resolve();
      await older;
      app.core.task = inspect;
    }
  },
  10_000,
);

test.each(["stop", "close", "peer", "unchanged"])(
  "a delayed admission failure preserves newer %s intent",
  async (scenario) => {
    const { app, port, provider, finished } = await fixture();
    if (scenario === "peer") {
      provider.setResponses([fauxAssistantMessage("Peer result")]);
      await port.emit(message("202"));
      await finished(app, "202");
    }
    const model = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    let modelEntered = false;
    provider.setResponses([
      (_context, options) => {
        modelEntered = true;
        const abort = () => model.resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
        return model.promise;
      },
      fauxAssistantMessage("Followup result"),
    ]);
    const submit = app.core.submit.bind(app.core);
    const release = Promise.withResolvers<void>();
    let entered = false;
    let operationId: string | undefined;
    app.core.submit = async (...args) => {
      const result = await submit(...args);
      if (!entered) {
        entered = true;
        operationId = result.operationId;
        await release.promise;
        throw new Error("Core admission outcome is uncertain");
      }
      return result;
    };
    const receiving = port.emit(message("102"));
    let newer: ReturnType<DiscordExtension["control"]> | undefined;
    try {
      await expect.poll(() => entered && modelEntered, { timeout: 5000 }).toBe(true);
      const issue = app.discord!.store.issue("102")!;
      const stopped = scenario === "stop" || scenario === "close";
      if (scenario !== "unchanged") {
        newer = app.discord!.control(
          scenario === "peer" ? "202" : "102",
          scenario === "close" ? "close" : "stop",
        );
        await expect
          .poll(() => app.discord!.store.issue(scenario === "peer" ? "202" : "102")?.state)
          .toBe(scenario === "close" ? "closed" : "stopped");
        if (stopped) {
          await expect.poll(() => app.discord!.store.input("102")?.state).toBe("cancelled");
          expect((await app.core.operation(issue.etaThreadId!, operationId!)).status).toBe(
            "aborted",
          );
        }
      }
      // The business stop has persisted and cancelled actual Core work; control still drains pump.
      release.resolve();
      await receiving;
      await newer;
      if (stopped) {
        await port.emit(message("103", "Followup while stopped", issue.discordThreadId!));
        if (app.discord!.store.input("103")) {
          await finished(app, "103");
          const reply = app.discord!.store.outputs("103")[0]!;
          expect(await port.findDelivery(reply.threadId, reply.marker)).toBe(reply.remoteId);
        }
        expect(app.discord!.store.input("103")).toBeUndefined();
        expect(app.discord!.store.issue("102")).toMatchObject({
          state: scenario === "close" ? "closed" : "stopped",
          error: null,
        });
        expect(app.discord!.store.input("102")?.state).toBe("cancelled");
      } else {
        expect(app.discord!.store.issue("102")?.state).toBe("review");
        expect(app.discord!.store.input("102")?.state).toBe("blocked");
        model.resolve(fauxAssistantMessage("Retained initial result"));
        await app.discord!.control("102", "resume");
        await finished(app, "102");
        expect(app.discord!.store.input("102")?.operationId).toBe(operationId);
        expect(
          (await app.core.openThread(issue.etaThreadId!)).snapshot.transcript.filter(
            ({ message }) => message.role === "user",
          ),
        ).toHaveLength(1);
        expect(app.discord!.store.outputs("102")[0]?.state).toBe("sent");
      }
    } finally {
      release.resolve();
      model.resolve(fauxAssistantMessage("Cleanup result"));
      await receiving;
      await newer;
      app.core.submit = submit;
    }
  },
  10_000,
);

test.each(
  ["send", "history-missing", "history-error"].flatMap((mode) =>
    ["stop", "close", "peer", "unchanged"].map((scenario) => [mode, scenario] as const),
  ),
)(
  "a delayed %s outcome preserves newer %s delivery control",
  async (mode, scenario) => {
    const { app, port, provider, finished } = await fixture();
    if (scenario === "peer") {
      provider.setResponses([fauxAssistantMessage("Peer reply")]);
      await port.emit(message("202"));
      await finished(app, "202");
    }
    provider.setResponses([
      fauxAssistantMessage("Initial reply"),
      fauxAssistantMessage("Followup reply"),
    ]);
    const send = port.send.bind(port);
    const find = port.findDelivery.bind(port);
    const release = Promise.withResolvers<void>();
    let firstSend = true;
    let entered = false;
    let settled = false;
    port.send = async (...args) => {
      if (firstSend) {
        firstSend = false;
        if (mode === "send") {
          entered = true;
          await release.promise;
          settled = true;
          throw new DeliveryError(false);
        }
        throw new Error("Delivery outcome is uncertain");
      }
      return send(...args);
    };
    port.findDelivery = async (...args) => {
      const result = await find(...args);
      if (mode !== "send" && !entered) {
        entered = true;
        await release.promise;
        settled = true;
        if (mode === "history-error") throw new Error("History is unavailable");
      }
      return result;
    };
    let newer: ReturnType<DiscordExtension["control"]> | undefined;
    try {
      await port.emit(message("102"));
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      const issue = app.discord!.store.issue("102")!;
      const input = app.discord!.store.input("102")!;
      expect((await app.core.operation(issue.etaThreadId!, input.operationId!)).status).toBe(
        "completed",
      );
      const stopped = scenario === "stop" || scenario === "close";
      if (scenario !== "unchanged") {
        newer = app.discord!.control(
          scenario === "peer" ? "202" : "102",
          scenario === "close" ? "close" : "stop",
        );
        await expect
          .poll(() => app.discord!.store.issue(scenario === "peer" ? "202" : "102")?.state)
          .toBe(scenario === "close" ? "closed" : "stopped");
      }
      // Stop waits for this actual reply phase to drain; its persisted intent must already win.
      release.resolve();
      await expect.poll(() => settled).toBe(true);
      await newer;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (stopped) {
        expect((await app.core.task(issue.etaThreadId!, input.taskId!)).state).toMatchObject({
          status: "terminal",
          outcome: { status: "aborted" },
        });
        expect(app.discord!.store.input("102")?.state).toBe("cancelled");
        await port.emit(message("103", "Followup after cancellation", issue.discordThreadId!));
        if (app.discord!.store.input("103")) {
          await finished(app, "103");
          const reply = app.discord!.store.outputs("103")[0]!;
          expect(await find(reply.threadId, reply.marker)).toBe(reply.remoteId);
        }
        expect(app.discord!.store.input("103")).toBeUndefined();
        expect(app.discord!.store.issue("102")).toMatchObject({
          state: scenario === "close" ? "closed" : "stopped",
          error: null,
        });
      } else {
        await expect
          .poll(() => app.discord!.store.outputs("102")[0]?.state)
          .toBe(mode === "send" ? "failed" : "review");
        expect(app.discord!.store.issue("102")?.state).toBe("review");
        await app.discord!.retryDelivery(app.discord!.store.outputs("102")[0]!.id);
        await finished(app, "102");
        expect(app.discord!.store.input("102")?.operationId).toBe(input.operationId);
        const reply = app.discord!.store.outputs("102")[0]!;
        expect(reply.state).toBe("sent");
        expect(await find(reply.threadId, reply.marker)).toBe(reply.remoteId);
      }
    } finally {
      release.resolve();
      await newer;
      port.send = send;
      port.findDelivery = find;
    }
  },
  10_000,
);
