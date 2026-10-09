import type { CoreClient, OperationAdmission, ImageAttachment } from "@eta/core";
import { BotHttpError } from "./errors.ts";
import type { BotLog } from "./log.ts";

/** Serialize writers to a checkout while allowing unrelated projects to run concurrently. */
export class BotController {
  private readonly active = new Map<string, string>();
  private readonly monitors = new Map<string, () => void>();
  private readonly recoveryQueue = new Set<string>();
  private readonly blocked = new Map<string, string>();
  private readonly blockedProjects = new Map<string, string>();
  private readonly threadProjects = new Map<string, string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing = false;
  constructor(
    private readonly core: CoreClient,
    private readonly workspaceProjects: ReadonlyMap<string, string>,
    private readonly maximum: number,
    private readonly log: BotLog = () => {},
  ) {}

  status() {
    return {
      activeThreads: [...this.active.keys()],
      pendingRecovery: [...this.recoveryQueue],
      blocked: Object.fromEntries(this.blocked),
    };
  }

  async authorize(id: string) {
    const view = await this.core.openThread(id);
    if (!this.workspaceProjects.has(view.thread.workspaceId))
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "This thread is outside the configured projects.",
      );
    this.threadProjects.set(id, this.workspaceProjects.get(view.thread.workspaceId)!);
    return view;
  }

  private block(id: string, message: string) {
    const previous = this.blocked.get(id);
    this.blocked.set(id, message);
    const project = this.threadProjects.get(id);
    if (project) this.blockedProjects.set(id, project);
    if (previous !== message) this.log({ event: "thread.blocked", threadId: id });
  }

  private async claim(id: string) {
    if (this.closing) throw new BotHttpError(503, "RuntimeClosing", "Bot is shutting down.");
    const view = await this.authorize(id);
    if (this.closing) throw new BotHttpError(503, "RuntimeClosing", "Bot is shutting down.");
    const project = this.workspaceProjects.get(view.thread.workspaceId)!;
    if (
      this.active.has(id) ||
      this.active.size >= this.maximum ||
      [...this.active.values()].includes(project) ||
      [...this.blockedProjects].some(([thread, root]) => thread !== id && root === project)
    )
      throw new BotHttpError(
        409,
        "Busy",
        "The project is already executing work or the concurrency limit was reached.",
      );
    this.active.set(id, project);
  }

  private release(id: string) {
    this.active.delete(id);
    this.monitors.get(id)?.();
    this.monitors.delete(id);
  }

  private async monitor(id: string) {
    let checking = false;
    const check = async () => {
      if (this.closing || checking || !this.active.has(id)) return;
      checking = true;
      try {
        const state = await this.core.recovery(id);
        if (!this.closing && !state.pending) {
          this.release(id);
          await this.pumpRecovery();
        }
      } catch (error) {
        if (!this.closing)
          this.block(id, error instanceof Error ? error.message : "Recovery inspection failed.");
      } finally {
        checking = false;
      }
    };
    const stop = await this.core.subscribe(id, check, (message) => {
      this.block(id, message);
    });
    // Host tasks can settle without changing the UI snapshot. Inspect their durable state as well.
    const timer = setInterval(() => {
      void check();
    }, 250);
    timer.unref();
    const dispose = () => {
      clearInterval(timer);
      stop();
    };
    if (this.closing || !this.active.has(id)) dispose();
    else this.monitors.set(id, dispose);
  }

  private track<T>(work: Promise<T>) {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work)).catch(() => {});
    return work;
  }

  submit(
    id: string,
    prompt: string,
    requestId: string,
    images?: readonly ImageAttachment[],
  ): Promise<OperationAdmission> {
    return this.track(
      (async () => {
        await this.authorize(id);
        const existing = await this.core.operationByRequest(id, requestId);
        if (existing)
          return {
            operationId: existing.operationId,
            kind: existing.kind,
            startedAt: existing.startedAt,
          };
        await this.claim(id);
        try {
          const admission = await this.core.submit(id, prompt, requestId, images);
          this.log({
            event: "operation.admitted",
            threadId: id,
            requestId,
            operationId: admission.operationId,
          });
          this.blocked.delete(id);
          this.blockedProjects.delete(id);
          await this.monitor(id);
          return admission;
        } catch (error) {
          this.release(id);
          throw error;
        }
      })(),
    );
  }

  resume(id: string) {
    return this.track(
      (async () => {
        await this.claim(id);
        this.recoveryQueue.delete(id);
        try {
          if ((await this.core.recovery(id)).blockedTasks.length)
            throw new BotHttpError(
              409,
              "MissingTaskDefinitions",
              "Install the required task definitions before resuming this thread.",
            );
          await this.core.resume(id);
          this.log({ event: "thread.resumed", threadId: id });
          this.blocked.delete(id);
          this.blockedProjects.delete(id);
          await this.monitor(id);
        } catch (error) {
          this.release(id);
          throw error;
        }
      })(),
    );
  }

  async stop(id: string) {
    await this.authorize(id);
    this.recoveryQueue.delete(id);
    await this.core.stop(id);
    this.log({ event: "thread.stopped", threadId: id });
    this.release(id);
    this.blocked.delete(id);
    this.blockedProjects.delete(id);
    await this.pumpRecovery();
  }

  async recover() {
    for (const thread of await this.core.threads(undefined, true)) {
      if (thread.archivedAt !== undefined || !this.workspaceProjects.has(thread.workspaceId))
        continue;
      this.threadProjects.set(thread.id, this.workspaceProjects.get(thread.workspaceId)!);
      const state = await this.core.recovery(thread.id).catch((error: unknown) => {
        this.blocked.set(
          thread.id,
          error instanceof Error ? error.message : "Recovery inspection failed.",
        );
        this.blockedProjects.set(thread.id, this.workspaceProjects.get(thread.workspaceId)!);
        return undefined;
      });
      if (state?.required) {
        if (state.unsafeTool || state.blockedTasks.length) {
          this.blocked.set(
            thread.id,
            "Recovery requires maintainer review of interrupted tools or task definitions.",
          );
          this.blockedProjects.set(thread.id, this.workspaceProjects.get(thread.workspaceId)!);
        } else this.recoveryQueue.add(thread.id);
      }
    }
    await this.pumpRecovery();
  }

  private async pumpRecovery() {
    if (this.closing) return;
    // Retried IDs are reinserted into the Set; iterate the initial queue once to avoid spinning on Busy.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const id of [...this.recoveryQueue]) {
      this.recoveryQueue.delete(id);
      try {
        await this.resume(id);
        this.recoveryQueue.delete(id);
      } catch (error) {
        if (error instanceof BotHttpError && error.code === "Busy") {
          this.recoveryQueue.add(id);
          continue;
        }
        this.recoveryQueue.delete(id);
        this.block(id, error instanceof Error ? error.message : "Recovery failed.");
      }
    }
  }

  async close(graceMs = 250) {
    this.closing = true;
    for (const stop of this.monitors.values()) stop();
    this.monitors.clear();
    await Promise.allSettled(this.inFlight);
    const deadline = Date.now() + graceMs;
    while (this.active.size && Date.now() < deadline) {
      for (const id of this.active.keys()) {
        const state = await this.core.recovery(id).catch(() => undefined);
        if (state && !state.pending) this.release(id);
      }
      if (this.active.size)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(20, Math.max(0, deadline - Date.now()))),
        );
    }
  }
}
