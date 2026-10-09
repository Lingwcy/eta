import { createHash } from "node:crypto";
import type { CoreClient, OperationResult } from "@eta/core";
import { BotController } from "../../src/controller.ts";
import { BotHttpError } from "../../src/errors.ts";
import { DiscordStore } from "./store.ts";
import type { Inbox, Issue } from "./store.ts";
import { createIssueTask, ISSUE_TASK_KIND } from "./task.ts";
import { DiscordSdk } from "./sdk.ts";
import { DeliveryError, MessageSchema } from "./types.ts";
import type { DiscordConfig, DiscordMessage, DiscordPort } from "./types.ts";
import { Schema } from "effect";
import type { Hono } from "hono";
import type { BotLog } from "../../src/log.ts";

interface Context {
  core: CoreClient;
  controller: BotController;
  workspaces: ReadonlyMap<string, string>;
  log: BotLog;
}

function chunks(text: string) {
  const result: string[] = [];
  let current = "";
  for (const character of text) {
    if (current.length + character.length > 1750) {
      result.push(current);
      current = "";
    }
    current += character;
  }
  if (current) result.push(current);
  return result;
}

/** The Bot owns network state; the runtime task handles the durable result/delivery boundary. */
export class DiscordExtension {
  readonly name = "discord";
  readonly store: DiscordStore;
  private context: Context | undefined;
  private accepting = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pumping: Promise<void> | undefined;
  private filling: Promise<void> | undefined;
  private error: string | null = null;
  private readonly limited = new Set<string>();
  private lastFill = 0;
  private readonly task;
  private readonly port: DiscordPort;
  constructor(
    private readonly config: DiscordConfig,
    path: string,
    port?: DiscordPort,
  ) {
    this.store = new DiscordStore(path);
    this.port = port ?? new DiscordSdk(config.tokenEnv);
    this.task = createIssueTask({
      core: () => this.host().core,
      stage: (input, result) => this.stage(input.inboxId, result),
      deliver: (id, signal) => this.deliver(id, signal),
      finish: (id) => this.finish(id),
      cancel: (id) => this.cancel(id),
    });
  }
  runtimeExtensions() {
    return [{ name: "eta-bot-discord", tasks: [this.task] }];
  }
  mount(app: Hono) {
    app.get("/v1/extensions/discord", (context) => context.json(this.status()));
    app.post("/v1/extensions/discord/issues/:id/:action", async (context) => {
      const action = context.req.param("action");
      if (action !== "stop" && action !== "resume" && action !== "close" && action !== "reopen")
        throw new BotHttpError(400, "InvalidInput", "Unknown Discord issue action.");
      return context.json(await this.control(context.req.param("id"), action));
    });
    app.post("/v1/extensions/discord/deliveries/:id/retry", async (context) =>
      context.json(await this.retryDelivery(context.req.param("id"))),
    );
  }
  initialize(context: Context) {
    for (const channel of this.config.channels)
      if (!context.workspaces.has(channel.projectKey))
        throw new Error("Discord channel refers to an unconfigured project key.");
    this.context = context;
  }
  private host() {
    if (!this.context) throw new Error("Discord extension is not initialized.");
    return this.context;
  }
  async prepareRecovery() {
    for (const issue of this.store.issues()) {
      if (issue.state !== "closed" && issue.state !== "stopped") continue;
      if (issue.etaThreadId) await this.host().controller.stop(issue.etaThreadId);
      for (const input of this.store
        .inputs()
        .filter((input) => input.issueId === issue.id && input.state !== "done"))
        this.store.updateInput(input.id, { state: "cancelled" });
    }
  }
  status() {
    return {
      connected: this.port.connected(),
      accepting: this.accepting,
      error: this.error,
      limitedBackfill: [...this.limited],
      issues: this.store.issues(),
      inputs: this.store.inputs(),
      deliveries: this.store.outputs(),
    };
  }
  async start() {
    if (this.config.enabled === false) return;
    for (const channel of this.config.channels)
      if (this.store.cursor(channel.channelId) === undefined)
        this.store.advance(
          channel.channelId,
          channel.startAfter ?? String(BigInt(Date.now() - 1420070400000) << 22n),
        );
    this.accepting = true;
    try {
      await this.port.start({
        message: (message) => this.receive(message),
        gap: () => this.backfill(),
      });
      this.error = null;
      await this.backfill();
    } catch {
      this.error = "Discord is unavailable; check credentials, intents and channel permissions.";
      this.host().log({ event: "discord.disconnected", code: "DiscordUnavailable" });
    }
    this.timer = setInterval(() => {
      void this.wake().catch(() => {
        this.error = "Discord queue processing failed; inspect blocked inputs.";
      });
      if (Date.now() - this.lastFill > 30000 && this.port.connected())
        void this.backfill().catch(() => {
          this.error = "Discord history could not be inspected.";
        });
    }, 250);
    this.timer.unref();
    await this.wake();
  }
  async receive(value: DiscordMessage) {
    if (!this.accepting || this.config.enabled === false) return;
    const message = Schema.decodeUnknownSync(MessageSchema)(value);
    if (message.bot || !message.content.trim()) return;
    const issue = this.store.issueForThread(message.guildId, message.channelId);
    if (issue) {
      if (
        issue.state !== "closed" &&
        issue.state !== "stopped" &&
        this.store.accept(message, issue.id)
      )
        this.host().log({ event: "discord.received", issueId: issue.id, inboxId: message.id });
    } else {
      const channel = this.config.channels.find(
        (channel) => channel.channelId === message.channelId && channel.guildId === message.guildId,
      );
      if (!channel || !message.content.startsWith(channel.triggerPrefix ?? "")) return;
      const cursor = this.store.cursor(channel.channelId);
      if (cursor !== undefined && BigInt(message.id) <= BigInt(cursor)) return;
      if (this.store.accept(message, message.id, channel.projectKey))
        this.host().log({ event: "discord.received", issueId: message.id, inboxId: message.id });
    }
    await this.wake();
  }
  wake() {
    if (!this.accepting || this.config.enabled === false) return Promise.resolve();
    return (this.pumping ??= this.pump().finally(() => {
      this.pumping = undefined;
    }));
  }
  private async pump() {
    const host = this.host();
    for (const initial of this.store.pumpIssues()) {
      if (!this.accepting) return;
      let issue = initial;
      if (issue.archivePending && !issue.error && this.port.connected()) {
        try {
          await this.syncArchive(issue);
        } catch {
          continue;
        }
        issue = this.store.issue(issue.id)!;
      }
      if (issue.state === "closed" || issue.state === "stopped") continue;
      if (this.store.pendingInputs(issue.id).some((input) => input.state === "blocked")) continue;
      try {
        const workspace = host.workspaces.get(issue.projectKey);
        if (!workspace) throw new Error("Discord project is no longer configured.");
        if (!issue.etaThreadId) {
          const thread = await host.core.createThread(workspace, `discord:create:${issue.id}`);
          this.store.updateIssue(issue.id, { etaThreadId: thread.id });
          issue = this.store.issue(issue.id)!;
          if (issue.state === "closed" || issue.state === "stopped") continue;
        }
        if (!issue.discordThreadId) {
          if (!this.port.connected()) continue;
          const id = await this.port.ensureThread(
            issue.source,
            `Issue: ${issue.source.content.slice(0, 80)}`,
          );
          this.store.updateIssue(issue.id, { discordThreadId: id });
          this.store.advance(id, issue.source.id);
          issue = this.store.issue(issue.id)!;
          if (issue.state === "closed" || issue.state === "stopped") continue;
        }
        const inputs = this.store.pendingInputs(issue.id);
        const first = inputs[0];
        if (!first || first.state === "blocked") continue;
        await this.admit(issue, first);
      } catch (error) {
        if (error instanceof BotHttpError && error.code === "Busy") continue;
        this.store.updateIssue(issue.id, {
          state: "review",
          error:
            "Issue admission requires maintainer review; verify the project and Discord permissions.",
        });
        const input = this.store
          .pendingInputs(issue.id)
          .find(
            (input) =>
              input.issueId === issue.id &&
              (input.state === "queued" || input.state === "admitted"),
          );
        if (input)
          this.store.updateInput(input.id, {
            state: "blocked",
            error: "Admission requires maintainer review.",
          });
      }
    }
  }
  private async admit(issue: Issue, input: Inbox) {
    const { core, controller } = this.host();
    const etaThreadId = issue.etaThreadId!;
    let operationId = input.operationId;
    if (!operationId) {
      const requestId = `discord:message:${input.id}`;
      const admission = await controller.submit(
        etaThreadId,
        `Discord support inquiry from ${input.message.authorId}:\n${input.message.content}\n\nInvestigate and reply to this customer. Do not publish, push code or create a pull request; those actions require a separate maintainer workflow.`,
        requestId,
      );
      operationId = admission.operationId;
      this.store.updateInput(input.id, { state: "admitted", operationId, error: null });
      const current = this.store.issue(issue.id)!;
      if (current.state === "closed" || current.state === "stopped") {
        await controller.stop(etaThreadId);
        this.store.updateInput(input.id, { state: "cancelled" });
        return;
      }
      this.store.updateIssue(issue.id, { state: "working", error: null });
    }
    if (!input.taskId) {
      const accepted = await core.enqueueTask(
        etaThreadId,
        ISSUE_TASK_KIND,
        { inboxId: input.id, etaThreadId, operationId },
        `discord:reply:${input.id}:${input.taskAttempt}`,
      );
      this.store.updateInput(input.id, { taskId: accepted.taskId });
      this.host().log({
        event: "discord.reply-task",
        issueId: issue.id,
        inboxId: input.id,
        threadId: etaThreadId,
        operationId,
        taskId: accepted.taskId,
      });
    } else {
      const task = await core.task(etaThreadId, input.taskId);
      if (task.state.status === "terminal" && task.state.outcome.status !== "completed")
        throw new BotHttpError(
          409,
          "TaskFailed",
          "The durable reply task ended without delivering its result.",
        );
    }
  }
  private stage(inboxId: string, result: OperationResult) {
    const input = this.store.input(inboxId)!;
    const issue = this.store.issue(input.issueId)!;
    const text =
      result.status === "completed"
        ? result.messages
            .flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                : [],
            )
            .join("\n") || "Investigation completed without a text response."
        : `Investigation ${result.status}. A maintainer can inspect the operation and choose how to continue.`;
    chunks(text).forEach((content, part) => {
      const id = `${inboxId}:${part}`;
      const nonce = createHash("sha256").update(`eta-discord:${id}`).digest("hex").slice(0, 24);
      const marker = `eta:${nonce}`;
      this.store.output({
        id,
        inboxId,
        issueId: issue.id,
        threadId: issue.discordThreadId!,
        content: `${content}\n-# ${marker}`,
        marker,
        nonce,
        state: "pending",
        remoteId: null,
        error: null,
      });
    });
    if (result.status !== "completed")
      this.store.updateIssue(issue.id, { state: "failed", error: `Operation ${result.status}.` });
  }
  private async deliver(inboxId: string, signal: AbortSignal) {
    if (this.config.enabled === false || !this.port.connected()) return false;
    for (const record of this.store.outputs(inboxId)) {
      signal.throwIfAborted();
      if (record.state === "sent") continue;
      if (record.state === "review" || record.state === "failed") return false;
      if (record.state === "sending") {
        try {
          const remoteId = await this.port.findDelivery(record.threadId, record.marker);
          if (remoteId) {
            this.store.updateOutput(record.id, { state: "sent", remoteId, error: null });
            continue;
          }
          this.store.updateOutput(record.id, {
            state: "review",
            error: "Previous delivery could not be confirmed in bounded history.",
          });
        } catch {
          this.store.updateOutput(record.id, {
            state: "review",
            error: "Previous delivery could not be inspected.",
          });
        }
        this.store.updateIssue(record.issueId, {
          state: "review",
          error: "A delivery needs reconciliation or an explicit retry.",
        });
        return false;
      }
      this.store.updateOutput(record.id, { state: "sending" });
      try {
        const remoteId = await this.port.send(record.threadId, record.content, record.nonce);
        this.store.updateOutput(record.id, { state: "sent", remoteId, error: null });
        this.host().log({
          event: "discord.delivered",
          issueId: record.issueId,
          inboxId,
          deliveryId: record.id,
        });
      } catch (error) {
        const state =
          error instanceof DeliveryError ? (error.retryable ? "pending" : "failed") : "sending";
        this.store.updateOutput(record.id, {
          state,
          error: "Discord delivery failed or its outcome is uncertain.",
        });
        if (state === "failed")
          this.store.updateIssue(record.issueId, {
            state: "review",
            error: "Discord rejected a reply; check permissions before retrying.",
          });
        signal.throwIfAborted();
        return false;
      }
    }
    return true;
  }
  private finish(inboxId: string) {
    const input = this.store.input(inboxId)!;
    this.store.updateInput(inboxId, { state: "done" });
    const issue = this.store.issue(input.issueId)!;
    if (!["failed", "closed", "stopped"].includes(issue.state))
      this.store.setState(issue.id, "waiting");
  }
  private cancel(inboxId: string) {
    const input = this.store.input(inboxId);
    if (!input) return;
    this.store.updateInput(inboxId, { state: "cancelled" });
    for (const record of this.store
      .outputs(inboxId)
      .filter((record) => record.inboxId === inboxId && record.state !== "sent"))
      this.store.updateOutput(record.id, {
        state: "failed",
        error: "Delivery cancelled by a maintainer.",
      });
  }
  backfill() {
    if (this.config.enabled === false || !this.port.connected()) return Promise.resolve();
    return (this.filling ??= this.fill().finally(() => {
      this.filling = undefined;
    }));
  }
  private async fill() {
    this.lastFill = Date.now();
    const channels = this.config.channels.map((channel) => ({
      id: channel.channelId,
      startAfter: channel.startAfter,
    }));
    for (const issue of this.store.issues())
      if (issue.discordThreadId && !["closed", "stopped"].includes(issue.state))
        channels.push({ id: issue.discordThreadId, startAfter: issue.source.id });
    for (const channel of channels) {
      if (!this.accepting) return;
      let cursor = this.store.cursor(channel.id);
      if (cursor === undefined) {
        if (channel.startAfter !== undefined) this.store.advance(channel.id, channel.startAfter);
        else {
          const latest = (await this.port.history(channel.id, { limit: 1 }))[0];
          this.store.advance(channel.id, latest?.id ?? "0");
          continue;
        }
        cursor = this.store.cursor(channel.id)!;
      }
      const limit = this.config.backfillLimit ?? 100;
      const collected: DiscordMessage[] = [];
      let before: string | undefined;
      let complete = false;
      while (collected.length < limit) {
        if (!this.accepting) return;
        const size = Math.min(100, limit - collected.length);
        const page = await this.port.history(channel.id, {
          limit: size,
          ...(before ? { before } : {}),
        });
        const newer = page.filter((message) => BigInt(message.id) > BigInt(cursor));
        collected.push(...newer);
        if (newer.length < page.length || page.length < size) {
          complete = true;
          break;
        }
        before = page.reduce<string | undefined>(
          (oldest, message) =>
            oldest === undefined || BigInt(message.id) < BigInt(oldest) ? message.id : oldest,
          undefined,
        );
        if (!before) {
          complete = true;
          break;
        }
      }
      if (!complete) this.limited.add(channel.id);
      else this.limited.delete(channel.id);
      for (const message of collected.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)))
        await this.receive(message);
      // A bounded scan that did not reach the old cursor must not silently acknowledge the gap.
      if (complete) for (const message of collected) this.store.advance(channel.id, message.id);
    }
  }
  async control(id: string, action: "stop" | "resume" | "close" | "reopen") {
    const issue = this.store.issue(id);
    if (!issue) throw new BotHttpError(404, "NotFound", "Discord issue not found.");
    if (action === "stop" || action === "close") {
      // Persist the business stop first so queued inputs cannot race cancellation.
      this.store.updateIssue(id, {
        state: action === "close" ? "closed" : "stopped",
        error: null,
        archivePending: action === "close",
      });
      if (issue.etaThreadId) await this.host().controller.stop(issue.etaThreadId);
      for (const input of this.store
        .inputs()
        .filter((input) => input.issueId === id && input.state !== "done"))
        this.store.updateInput(input.id, { state: "cancelled" });
      if (action === "close" && issue.discordThreadId)
        await this.syncArchive(this.store.issue(id)!);
    } else {
      if (
        action === "resume" &&
        issue.etaThreadId &&
        (await this.host().core.recovery(issue.etaThreadId)).required
      )
        await this.host().controller.resume(issue.etaThreadId);
      this.store.updateIssue(id, {
        state: "waiting",
        error: null,
        archivePending: action === "reopen",
      });
      if (action === "reopen" && issue.discordThreadId)
        await this.syncArchive(this.store.issue(id)!);
      for (const input of this.store
        .inputs()
        .filter((input) => input.issueId === id && input.state === "blocked")) {
        if (input.taskId && issue.etaThreadId) {
          const task = await this.host().core.task(issue.etaThreadId, input.taskId);
          if (task.state.status === "terminal" && task.state.outcome.status !== "completed")
            this.store.updateInput(input.id, { taskId: null, taskAttempt: input.taskAttempt + 1 });
        }
        this.store.updateInput(input.id, {
          state: input.operationId ? "admitted" : "queued",
          error: null,
        });
      }
    }
    await this.wake();
    return this.store.issue(id)!;
  }
  async retryDelivery(id: string) {
    const record = this.store.delivery(id);
    if (!record) throw new BotHttpError(404, "NotFound", "Discord delivery not found.");
    if (record.state === "sent") return record;
    const issue = this.store.issue(record.issueId)!;
    if (
      issue.state === "closed" ||
      issue.state === "stopped" ||
      this.store.input(record.inboxId)?.state === "cancelled"
    )
      throw new BotHttpError(409, "IssueStopped", "A cancelled delivery cannot be retried.");
    const remoteId = await this.port.findDelivery(record.threadId, record.marker);
    this.store.updateOutput(
      id,
      remoteId ? { state: "sent", remoteId, error: null } : { state: "pending", error: null },
    );
    return this.store.delivery(id)!;
  }
  async stopIngress() {
    this.accepting = false;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(
      [this.pumping, this.filling].filter((work): work is Promise<void> => work !== undefined),
    );
  }
  private async syncArchive(issue: Issue) {
    if (!issue.discordThreadId) return;
    try {
      await this.port.archive(issue.discordThreadId, issue.state === "closed");
      this.store.updateIssue(issue.id, { archivePending: false, error: null });
    } catch {
      this.store.updateIssue(issue.id, {
        error: "Discord archive update failed; repeat close or reopen after checking permissions.",
      });
      throw new BotHttpError(
        503,
        "DiscordUnavailable",
        "The issue state was saved but its Discord archive update needs retrying.",
      );
    }
  }
  async close() {
    await this.stopIngress();
    await this.port.stop();
    this.store.close();
  }
}
