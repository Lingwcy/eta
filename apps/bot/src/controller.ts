import type { SubagentCommand } from "@eta/core/shared/subagents";
import type { CoreClient, OperationAdmission, ImageAttachment } from "@eta/core";
import { BotHttpError } from "./errors.ts";
import type { BotLog } from "./log.ts";

type AdmissionLease = { projectId: string; stopResult?: Promise<boolean> };

/** Serialize writers to a checkout while allowing unrelated projects to run concurrently. */
export class BotController {
  private readonly active = new Map<string, AdmissionLease>();
  private readonly monitors = new Map<string, () => void>();
  private readonly recoveryQueue = new Set<string>();
  private readonly blocked = new Map<string, string>();
  private readonly blockedProjects = new Map<string, string>();
  private readonly threadProjects = new Map<string, string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing = false;
  private readonly capacityListeners = new Set<() => void>();
  constructor(
    private readonly core: CoreClient,
    private readonly workspaceProjects: ReadonlyMap<string, string>,
    private readonly maximum: number,
    private readonly log: BotLog = () => {},
  ) {}

  subscribeCapacity(listener: () => void) {
    this.capacityListeners.add(listener);
    return () => this.capacityListeners.delete(listener);
  }

  status() {
    return {
      activeThreads: [...this.active.keys()],
      pendingRecovery: [...this.recoveryQueue],
      blocked: Object.fromEntries(this.blocked),
    };
  }

  scheduleBlockReason(id: string) {
    const project = this.threadProjects.get(id);
    if (
      project &&
      [...this.blockedProjects].some(([thread, root]) => thread !== id && root === project)
    )
      return "projectBlocked";
    return undefined;
  }

  async authorize(id: string) {
    const thread = await this.core.threadMetadata(id);
    if (!this.workspaceProjects.has(thread.workspaceId))
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "This thread is outside the configured projects.",
      );
    this.threadProjects.set(id, this.workspaceProjects.get(thread.workspaceId)!);
    return thread;
  }

  private block(id: string, message: string) {
    const previous = this.blocked.get(id);
    this.blocked.set(id, message);
    const project = this.threadProjects.get(id);
    if (project) this.blockedProjects.set(id, project);
    if (previous !== message) this.log({ event: "thread.blocked", threadId: id });
  }

  private async claim(id: string): Promise<AdmissionLease> {
    if (this.closing) throw new BotHttpError(503, "RuntimeClosing", "Bot is shutting down.");
    const thread = await this.authorize(id);
    if (this.closing) throw new BotHttpError(503, "RuntimeClosing", "Bot is shutting down.");
    const project = this.workspaceProjects.get(thread.workspaceId);
    if (!project)
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "This thread is outside the configured projects.",
      );
    if (
      this.active.has(id) ||
      this.active.size >= this.maximum ||
      [...this.active.values()].some((lease) => lease.projectId === project) ||
      [...this.blockedProjects].some(([thread, root]) => thread !== id && root === project)
    )
      throw new BotHttpError(
        409,
        "Busy",
        "The project is already executing work or the concurrency limit was reached.",
      );
    // Object identity separates successive admissions of the same thread.
    const lease = { projectId: project };
    this.active.set(id, lease);
    return lease;
  }

  private release(id: string, lease: AdmissionLease | undefined) {
    if (!lease || this.active.get(id) !== lease) return;
    const released = this.active.delete(id);
    this.monitors.get(id)?.();
    this.monitors.delete(id);
    if (released) this.notifyCapacity();
  }

  private notifyCapacity() {
    for (const listener of this.capacityListeners) {
      try {
        listener();
      } catch {
        this.log({ event: "scheduler.listener-failed" });
      }
    }
  }

  private async monitor(id: string, lease: AdmissionLease) {
    const current = () => !this.closing && this.active.get(id) === lease;
    if (!current()) return;
    let checking = false;
    const check = async () => {
      if (!current() || checking) return;
      checking = true;
      try {
        const state = await this.core.recovery(id);
        if (current() && !state.pending) {
          this.release(id, lease);
          await this.pumpRecovery();
        } else if (current() && state.queuedOnly && !state.required && !state.blockedTasks.length) {
          const { snapshot } = await this.core.openThread(id);
          // Model errors leave follow-ups queued for the next input. End this failed turn's
          // delegated work before releasing its checkout; recurring plans can try again later.
          if (current() && !snapshot.operation && snapshot.lastResult?.status === "failed")
            await this.stopAdmission(id, lease);
        }
      } catch (error) {
        if (current())
          this.block(id, error instanceof Error ? error.message : "Recovery inspection failed.");
      } finally {
        checking = false;
      }
    };
    const stop = await this.core.subscribe(id, check, (message) => {
      if (current()) this.block(id, message);
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
    if (!current()) dispose();
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
        const lease = await this.claim(id);
        try {
          const admission = await this.core.submit(id, prompt, requestId, images);
          this.log({
            event: "operation.admitted",
            threadId: id,
            requestId,
            operationId: admission.operationId,
          });
          if (this.active.get(id) === lease) {
            this.blocked.delete(id);
            this.blockedProjects.delete(id);
          }
          await this.monitor(id, lease);
          return admission;
        } catch (error) {
          this.release(id, lease);
          throw error;
        }
      })(),
    );
  }

  resume(id: string) {
    return this.resumeAdmission(id);
  }

  private resumeAdmission(id: string, onSupersededFailure?: () => void) {
    return this.track(
      (async () => {
        const lease = await this.claim(id);
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
          if (this.active.get(id) === lease) {
            this.blocked.delete(id);
            this.blockedProjects.delete(id);
          }
          await this.monitor(id, lease);
        } catch (error) {
          // A stop may supersede this failure, but it owns the lease until Core confirms stop.
          const stopSucceeded = lease.stopResult ? await lease.stopResult : false;
          const superseded = this.active.get(id) !== lease || stopSucceeded;
          if (superseded) onSupersededFailure?.();
          if (!stopSucceeded) this.release(id, lease);
          throw error;
        }
      })(),
    );
  }

  compact(id: string) {
    return this.track(
      (async () => {
        const lease = await this.claim(id);
        try {
          await this.core.compact(id);
        } finally {
          this.release(id, lease);
          await this.pumpRecovery();
        }
      })(),
    );
  }

  subagent(id: string, command: SubagentCommand, requestId: string) {
    return this.track(
      (async () => {
        await this.authorize(id);
        if (!["spawn", "send", "resume"].includes(command.action) || this.active.has(id))
          return this.core.subagent(id, command, requestId);
        const lease = await this.claim(id);
        try {
          const result = await this.core.subagent(id, command, requestId);
          await this.monitor(id, lease);
          return result;
        } catch (error) {
          this.release(id, lease);
          throw error;
        }
      })(),
    );
  }

  stop(id: string) {
    return this.stopAdmission(id);
  }

  private async stopAdmission(id: string, expectedLease?: AdmissionLease) {
    await this.authorize(id);
    if (expectedLease && this.active.get(id) !== expectedLease) return;
    this.recoveryQueue.delete(id);
    const lease = this.active.get(id);
    const stopResult = Promise.withResolvers<boolean>();
    if (lease) lease.stopResult = stopResult.promise;
    try {
      await this.core.stop(id);
      stopResult.resolve(true);
    } catch (error) {
      stopResult.resolve(false);
      throw error;
    }
    this.log({ event: "thread.stopped", threadId: id });
    if (this.active.get(id) === lease) {
      this.blocked.delete(id);
      const unblocked = this.blockedProjects.delete(id);
      this.release(id, lease);
      // Interrupted work has no live admission lease, but stopping it frees the checkout.
      if (!lease && unblocked) this.notifyCapacity();
    }
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
        if (state.unsafeTool && !state.blockedTasks.length) {
          try {
            if (await this.cancelInterruptedSchedule(thread.id)) continue;
          } catch (error) {
            this.block(
              thread.id,
              error instanceof Error ? error.message : "Interrupted schedule cleanup failed.",
            );
            continue;
          }
        }
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

  /** Cancel an interrupted scheduled run rather than replaying a tool with uncertain side effects. */
  private async cancelInterruptedSchedule(id: string) {
    const operation = (await this.core.openThread(id)).snapshot.operation;
    if (!operation) return false;
    const { originOperationId } = await this.core.operation(id, operation.id);
    const snapshot = await this.core.scheduleSnapshot();
    for (const run of snapshot.occurrences ?? []) {
      if (run.threadId !== id) continue;
      const inFlight = ["dispatching", "admitted"].includes(run.state);
      if (!inFlight && (originOperationId === undefined || run.operationId !== originOperationId))
        continue;
      // A crash can precede the dispatcher's receipt write; Core's request identity is authoritative.
      const operationId =
        run.operationId ?? (await this.core.operationByRequest(id, run.requestId))?.operationId;
      const direct = inFlight && operationId === operation.id;
      if (!direct && (originOperationId === undefined || operationId !== originOperationId))
        continue;
      await this.core.stop(id);
      this.log({
        event: "schedule.interrupted",
        threadId: id,
        operationId: operation.id,
        requestId: run.requestId,
      });
      return true;
    }
    return false;
  }

  private async pumpRecovery() {
    if (this.closing) return;
    // Retried IDs are reinserted into the Set; iterate the initial queue once to avoid spinning on Busy.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const id of [...this.recoveryQueue]) {
      this.recoveryQueue.delete(id);
      let superseded = false;
      try {
        await this.resumeAdmission(id, () => {
          superseded = true;
        });
        this.recoveryQueue.delete(id);
      } catch (error) {
        if (superseded) continue;
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
      for (const [id, lease] of this.active) {
        const state = await this.core.recovery(id).catch(() => undefined);
        if (state && !state.pending) this.release(id, lease);
      }
      if (this.active.size)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(20, Math.max(0, deadline - Date.now()))),
        );
    }
  }
}
