import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createBotApplication } from "../../src/application.ts";
import type { BotApplication } from "../../src/application.ts";
import type { BotConfig } from "../../src/config.ts";
import type { DiscordMessage, DiscordPort } from "./types.ts";
import { DeliveryError } from "./types.ts";

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
): DiscordMessage {
  return {
    id,
    content,
    channelId,
    guildId: "1",
    authorId: bot ? "99" : "20",
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
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eta-discord-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
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
      fauxToolCall("write", { path: "discord-proof.txt", content: "Discord investigation" }),
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

test("restoring a stopped data-directory backup preserves association, queue and pending delivery", async () => {
  const { app, open, port, provider, config, finished } = await fixture();
  provider.setResponses([fauxAssistantMessage("Restored delivery")]);
  port.failure = new DeliveryError(true);
  await port.emit(message("1100"));
  await expect.poll(() => app.discord!.store.outputs()[0]?.state).toBe("pending");
  const issue = app.discord!.store.issue("1100")!;
  await app.close();
  const backup = `${config.dataRoot}-backup`;
  await cp(config.dataRoot, backup, { recursive: true });
  await rm(config.dataRoot, { recursive: true });
  await cp(backup, config.dataRoot, { recursive: true });
  const restored = await open();
  await finished(restored, "1100");
  expect(restored.discord!.store.issue("1100")?.etaThreadId).toBe(issue.etaThreadId);
  expect(restored.discord!.store.inputs()).toHaveLength(1);
  expect(restored.discord!.store.outputs()).toHaveLength(1);
  expect(port.sendCalls).toBe(2);
});
