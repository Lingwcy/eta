import { fork } from "node:child_process";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, ManagedRuntime, Schema } from "effect";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { expect, test } from "vite-plus/test";
import { testServices } from "../../support/runtime.ts";
import { ThreadService } from "@eta/core/service/threads/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import { ScheduleService } from "@eta/core/service/schedules/index";
import { ScheduleDispatcherService } from "@eta/core/service/schedules/dispatcher";
import { scheduleHostAdapter } from "@eta/core/service/schedules/host";

const ReportSchema = Schema.Struct({
  threadId: Schema.NonEmptyString,
  sessionPath: Schema.optionalKey(Schema.NonEmptyString),
  scheduledAt: Schema.Number,
  phase: Schema.String,
});

test.each(["pending", "dispatching", "submitted", "recorded", "finished"])(
  "SIGKILL at %s recovers one scheduled UserMessage with a stable delivery receipt",
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "eta-schedule-kill-"));
    const dataRoot = join(root, "data");
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const child = fork(new URL("./crash-worker.ts", import.meta.url), [dataRoot, cwd, phase], {
      execArgv: [
        "--experimental-strip-types",
        "--import",
        fileURLToPath(new URL("../threads/source-loader.ts", import.meta.url)),
      ],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let diagnostics = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    let close: (() => Promise<void>) | undefined;
    try {
      const report = await new Promise<typeof ReportSchema.Type>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Crash worker timed out: ${diagnostics}`)),
          8000,
        );
        child.once("message", (message) => {
          clearTimeout(timeout);
          try {
            resolve(Schema.decodeUnknownSync(ReportSchema)(message));
          } catch (error) {
            reject(error);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Crash worker exited ${code}: ${diagnostics}`));
        });
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
      const provider = fauxProvider({
        provider: "schedule-crash",
        models: [{ id: "one" }],
        tokensPerSecond: 10000,
      });
      provider.setResponses([fauxAssistantMessage("Recovered scheduled work")]);
      const models = createModels();
      models.setProvider(provider.provider);
      const reopened = ManagedRuntime.make(testServices(dataRoot, models));
      close = () => reopened.dispose();
      const threads = await reopened.runPromise(ThreadService);
      const workspaces = await reopened.runPromise(WorkspaceService);
      const schedules = await reopened.runPromise(ScheduleService);
      const dispatcher = await reopened.runPromise(ScheduleDispatcherService);
      let submissions = 0;
      const adapter = scheduleHostAdapter(
        {
          submit: (id, prompt, requestId) => {
            submissions++;
            return reopened.runPromise(threads.submit(id, prompt, requestId));
          },
          operationByRequest: (id, requestId) =>
            reopened.runPromise(threads.operationByRequest(id, requestId)),
          recovery: (id) => reopened.runPromise(threads.recovery(id)),
        },
        async (id) => {
          const thread = await reopened.runPromise(threads.get(id));
          await reopened.runPromise(workspaces.validate(thread.workspaceId));
          return undefined;
        },
      );
      await reopened.runPromise(dispatcher.tick(adapter, report.scheduledAt + 1));
      const schedule = (await reopened.runPromise(schedules.list(report.threadId)))[0];
      const occurrence = (await reopened.runPromise(schedules.runs(schedule.id)))[0];
      const opened = await reopened.runPromise(threads.open(report.threadId));
      if (opened.snapshot.recoveryRequired)
        await reopened.runPromise(threads.resume(report.threadId));
      await expect
        .poll(
          async () =>
            (await reopened.runPromise(threads.operation(report.threadId, occurrence.operationId!)))
              .status,
          { timeout: 10000 },
        )
        .toBe("completed");
      await reopened.runPromise(dispatcher.tick(adapter, report.scheduledAt + 2));
      await reopened.runPromise(dispatcher.tick(adapter, report.scheduledAt + 3));
      const final = await reopened.runPromise(threads.open(report.threadId));
      expect(
        final.snapshot.transcript.filter((entry) => entry.message.role === "user"),
      ).toHaveLength(1);
      expect(submissions).toBe(["pending", "dispatching"].includes(phase) ? 1 : 0);
      const finalRuns = await reopened.runPromise(schedules.runs(schedule.id));
      expect(finalRuns).toHaveLength(1);
      expect(finalRuns[0].requestId).toBe(occurrence.requestId);
      expect(finalRuns[0].state).toBe("succeeded");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
      await close?.();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);

test.each([
  "archive-prepared",
  "archive-intent",
  "archive-catalog",
  "archive-complete",
  "delete-prepared",
  "delete-intent",
  "delete-catalog",
  "delete-complete",
])(
  "SIGKILL at %s reconciles both durable stores before restoration or new delivery",
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "eta-schedule-lifecycle-kill-"));
    const dataRoot = join(root, "data");
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const child = fork(new URL("./crash-worker.ts", import.meta.url), [dataRoot, cwd, phase], {
      execArgv: [
        "--experimental-strip-types",
        "--import",
        fileURLToPath(new URL("../threads/source-loader.ts", import.meta.url)),
      ],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let diagnostics = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    let close: (() => Promise<void>) | undefined;
    try {
      const report = await new Promise<typeof ReportSchema.Type>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Lifecycle worker timed out: ${diagnostics}`)),
          8000,
        );
        child.once("message", (message) => {
          clearTimeout(timer);
          try {
            resolve(Schema.decodeUnknownSync(ReportSchema)(message));
          } catch (error) {
            reject(error);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Lifecycle worker exited ${code}: ${diagnostics}`));
        });
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
      const provider = fauxProvider({
        provider: "schedule-crash",
        models: [{ id: "one" }],
        tokensPerSecond: 10000,
      });
      provider.setResponses([fauxAssistantMessage("Should not run")]);
      const models = createModels();
      models.setProvider(provider.provider);
      const reopened = ManagedRuntime.make(testServices(dataRoot, models));
      close = () => reopened.dispose();
      const threads = await reopened.runPromise(ThreadService);
      const schedules = await reopened.runPromise(ScheduleService);
      const snapshot = await reopened.runPromise(schedules.snapshot);
      expect(snapshot.lifecycleIntents).toEqual([]);
      expect(snapshot.requests).toEqual([]);
      const original = snapshot.schedules[0];
      if (phase.endsWith("intent") || phase.endsWith("prepared")) {
        expect(
          (await reopened.runPromise(threads.get(report.threadId))).archivedAt,
        ).toBeUndefined();
        expect(original.state).toBe("active");
        expect(original.deletedAt).toBeUndefined();
        expect(snapshot.proposals[0].state).toBe("pending");
        expect(
          (await reopened.runPromise(threads.open(report.threadId))).snapshot.transcript,
        ).toEqual([]);
        // Retry the actual user action after startup has rolled back the uncommitted intention.
        await reopened.runPromise(
          phase.startsWith("archive-")
            ? threads.archive(report.threadId, true)
            : threads.remove(report.threadId),
        );
      }
      if (phase.startsWith("archive-")) {
        expect((await reopened.runPromise(threads.get(report.threadId))).archivedAt).toBeDefined();
        expect((await reopened.runPromise(schedules.list(report.threadId)))[0].state).toBe(
          "paused",
        );
        expect((await reopened.runPromise(schedules.proposals(report.threadId)))[0].state).toBe(
          "invalidated",
        );
        await reopened.runPromise(threads.archive(report.threadId, false));
        expect((await reopened.runPromise(schedules.list(report.threadId)))[0].state).toBe(
          "paused",
        );
      } else {
        expect((await reopened.runPromise(Effect.flip(threads.get(report.threadId)))).code).toBe(
          "NotFound",
        );
        expect(await reopened.runPromise(schedules.list(report.threadId))).toEqual([]);
        expect(
          (await reopened.runPromise(schedules.snapshot)).schedules[0].deletedAt,
        ).toBeDefined();
        await expect(stat(report.sessionPath!)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const dispatcher = await reopened.runPromise(ScheduleDispatcherService);
      let submissions = 0;
      const host = scheduleHostAdapter(
        {
          submit: (id, prompt, requestId) => {
            submissions++;
            return reopened.runPromise(threads.submit(id, prompt, requestId));
          },
          operationByRequest: (id, requestId) =>
            reopened.runPromise(threads.operationByRequest(id, requestId)),
          recovery: (id) => reopened.runPromise(threads.recovery(id)),
        },
        async () => undefined,
      );
      await reopened.runPromise(dispatcher.tick(host, report.scheduledAt + 300000));
      expect(submissions).toBe(0);
      expect(provider.state.callCount).toBe(0);
      expect(await reopened.runPromise(schedules.runs(original.id))).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
      await close?.();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
