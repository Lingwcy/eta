import type { BotApplication } from "./application.ts";
import type { ScheduleOccurrence } from "@eta/core/shared/schedules";

type Sample<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; message: string }
  | { kind: "timeout" };
const message = (error: unknown) =>
  (error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Non-error failure"
  ).slice(0, 400);
function sample<T>(read: () => T | Promise<T>, deadline: number): Promise<Sample<T>> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.resolve({ kind: "timeout" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
    void Promise.resolve()
      .then(read)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve({ kind: "value", value });
        },
        (error: unknown) => {
          clearTimeout(timer);
          resolve({ kind: "error", message: message(error) });
        },
      );
  });
}
const occurrence = (run: ScheduleOccurrence | undefined) =>
  run && {
    id: run.id,
    requestId: run.requestId,
    state: run.state,
    reason: run.reason,
    operationId: run.operationId,
    admittedAt: run.admittedAt,
    finishedAt: run.finishedAt,
  };

/** Failure-only reads share one budget and never print prompts, images or configuration. */
export async function scheduleDiagnostics(
  bot: Pick<BotApplication, "core" | "controller">,
  target: {
    threadId: string;
    scheduleId: string;
    requestId: string;
    observed?: ScheduleOccurrence;
    modelBefore: Record<string, number | boolean>;
    modelAfter: Record<string, number | boolean>;
  },
  budgetMs = 1000,
) {
  const sampledAt = new Date().toISOString();
  const started = performance.now();
  const deadline = started + budgetMs;
  const operation = async (operationId: string) =>
    sample(async () => {
      const value = await bot.core.operation(target.threadId, operationId);
      return { operationId, status: value.status, error: value.error };
    }, deadline);
  const runs = sample(
    async () =>
      occurrence(
        (await bot.core.listScheduleRuns({ scheduleId: target.scheduleId })).find((run) =>
          run.requestId.includes(target.requestId),
        ),
      ),
    deadline,
  );
  const controller = sample(() => bot.controller.status(), deadline);
  const thread = sample(async () => {
    const { snapshot } = await bot.core.openThread(target.threadId);
    return {
      operation: snapshot.operation && {
        id: snapshot.operation.id,
        status: snapshot.operation.status,
        retry: snapshot.operation.retry,
        deferred: snapshot.operation.deferred,
        waitingForSubagents: snapshot.operation.waitingForSubagents,
        waitingForApproval: snapshot.operation.waitingForApproval,
        runningTools: snapshot.operation.runningTools.map((tool) => ({
          id: tool.toolCallId,
          status: tool.status,
        })),
      },
      lastResult: snapshot.lastResult && {
        operationId: snapshot.lastResult.operationId,
        status: snapshot.lastResult.status,
        error: snapshot.lastResult.error,
      },
      recoveryRequired: snapshot.recoveryRequired,
      blockedReason: snapshot.blockedReason,
      faulted: snapshot.faulted,
      subagents: snapshot.subagents?.map((child) => ({ path: child.path, status: child.status })),
    };
  }, deadline);
  const current = await runs;
  const operationId =
    (current.kind === "value" ? current.value?.operationId : undefined) ??
    target.observed?.operationId;
  const record = operationId ? await operation(operationId) : { kind: "unavailable" as const };
  return {
    sampledAt,
    elapsedMs: performance.now() - started,
    budgetMs,
    target: {
      threadId: target.threadId,
      scheduleId: target.scheduleId,
      requestId: target.requestId,
    },
    observed: occurrence(target.observed),
    occurrence: current,
    operation: record,
    controller: await controller,
    thread: await thread,
    modelBefore: target.modelBefore,
    modelAfter: target.modelAfter,
  };
}

/** Diagnostics may fail too; they must never replace the original assertion. */
export async function withScheduleDiagnostics(
  assertion: () => Promise<unknown>,
  collect: () => Promise<unknown>,
  report: (value: unknown) => void = (value) =>
    console.error("Scheduled quota failure diagnostics", JSON.stringify(value)),
) {
  try {
    await assertion();
  } catch (failure) {
    try {
      report(await collect());
    } catch (diagnosticError) {
      try {
        console.error("Unable to report schedule diagnostics", message(diagnosticError));
      } catch {
        /* The assertion still owns this failure. */
      }
    }
    throw failure;
  }
}
