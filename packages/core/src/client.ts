import type { CreateThreadConfiguration } from "./agent/protocol.ts";
import type { SandboxMode } from "./shared/sandbox.ts";
import { Effect, ManagedRuntime } from "effect";
import type { JsonValue } from "@earendil-works/chord";
import type { ImageAttachment } from "./images/types.ts";
import type { ThinkingLevel } from "./agent/protocol.ts";
import type { SubagentCommand } from "./shared/subagents.ts";
import { coreServices } from "./layer.ts";
import type { CoreOptions } from "./layer.ts";
import {
  ScheduleDispatcherService,
  type ScheduleHostAdapter,
} from "./service/schedules/dispatcher.ts";
import { ScheduleService } from "./service/schedules/index.ts";
import { ScheduleStoreService } from "./service/schedules/store.ts";
import { CoreError } from "./service/errors.ts";
import type { Schedule, ScheduleRule, ScheduleProposal } from "./shared/schedules.ts";
import type { ScheduleChange } from "./shared/schedules.ts";
import type {
  ScheduleWriteInput,
  ScheduleProposeInput,
  ScheduleDecisionInput,
} from "./service/schedules/management.ts";
import { CatalogService } from "./service/catalog/index.ts";
import { ProjectService } from "./service/projects/index.ts";
import { WorkspaceService } from "./service/workspaces/index.ts";
import { ThreadService } from "./service/threads/index.ts";
import { SkillsService } from "./service/skills/index.ts";
import { ModelCatalogService } from "./service/models/index.ts";
import { GitRepositoryService } from "./service/git/index.ts";
import { WorktreeService } from "./service/git/worktrees.ts";
import { GitHubRepositoryService } from "./service/git/github.ts";
import type { GitHubQuery } from "./shared/github.ts";
import type { CreateWorktreeInput } from "./service/git/worktrees.ts";
import { AppPathsService } from "./platform/app-paths.ts";
import { readReviewStats } from "./service/runtime/review-log.ts";

/** Each invocation creates an independent service graph; the host owns its lifetime through close. */
export async function createCore(options: CoreOptions) {
  const runtime = ManagedRuntime.make(coreServices(options));
  try {
    const threads = await runtime.runPromise(ThreadService);
    const projects = await runtime.runPromise(ProjectService);
    const workspaces = await runtime.runPromise(WorkspaceService);
    const models = await runtime.runPromise(ModelCatalogService);
    const skills = await runtime.runPromise(SkillsService);
    const catalog = await runtime.runPromise(CatalogService);
    const git = await runtime.runPromise(GitRepositoryService);
    const worktrees = await runtime.runPromise(WorktreeService);
    const github = await runtime.runPromise(GitHubRepositoryService);
    const paths = await runtime.runPromise(AppPathsService);
    const schedules = await runtime.runPromise(ScheduleService);
    const scheduleStore = await runtime.runPromise(ScheduleStoreService);
    const scheduler = await runtime.runPromise(ScheduleDispatcherService);
    const scheduleThread = Effect.fn("CoreClient.scheduleThread")(function* (scheduleId: string) {
      const schedule = (yield* scheduleStore.read).schedules[scheduleId];
      if (!schedule) return yield* new CoreError({ code: "NotFound", message: "定时任务不存在" });
      return schedule.threadId;
    });
    const stopScheduledThread = Effect.fn("CoreClient.stopScheduledThread")(function* (
      threadId: string,
    ) {
      if (!(yield* scheduler.interrupt(threadId))) yield* threads.stop(threadId);
    });
    const restartScheduledThread = Effect.fn("CoreClient.restartScheduledThread")(function* (
      threadId: string,
    ) {
      const recovery = yield* threads.recovery(threadId);
      if (!recovery.required && !recovery.blockedTasks.length) return false;
      yield* stopScheduledThread(threadId);
      return true;
    });
    const changeSchedule = (input: {
      requestId: string;
      change: Exclude<ScheduleChange, { action: "create" }>;
    }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const threadId = yield* scheduleThread(input.change.scheduleId);
          return yield* schedules.write(
            {
              threadId,
              requestId: input.requestId,
              change: input.change,
            },
            stopScheduledThread(threadId),
          );
        }),
      );
    let closing: Promise<void> | undefined;
    return {
      startScheduler: (host: ScheduleHostAdapter) => runtime.runPromise(scheduler.start(host)),
      stopScheduler: () => runtime.runPromise(scheduler.stop),
      listSchedules: (input: { threadId?: string; state?: Schedule["state"] } = {}) =>
        runtime.runPromise(
          schedules
            .list(input.threadId)
            .pipe(
              Effect.map((values) =>
                values.filter((schedule) => !input.state || schedule.state === input.state),
              ),
            ),
        ),
      createSchedule: (input: {
        threadId: string;
        name: string;
        prompt: string;
        rule: ScheduleRule;
        requestId: string;
      }) =>
        runtime.runPromise(
          schedules.write({
            threadId: input.threadId,
            requestId: input.requestId,
            change: { action: "create", name: input.name, prompt: input.prompt, rule: input.rule },
          }),
        ),
      changeSchedule: (input: ScheduleWriteInput) =>
        runtime.runPromise(schedules.write(input, stopScheduledThread(input.threadId))),
      updateSchedule: (input: {
        scheduleId: string;
        expectedRevision: number;
        patch: Extract<ScheduleChange, { action: "update" }>["patch"];
        requestId: string;
      }) =>
        changeSchedule({
          requestId: input.requestId,
          change: {
            action: "update",
            scheduleId: input.scheduleId,
            expectedRevision: input.expectedRevision,
            patch: input.patch,
          },
        }),
      pauseSchedule: (input: { scheduleId: string; expectedRevision: number; requestId: string }) =>
        changeSchedule({
          requestId: input.requestId,
          change: {
            action: "pause",
            scheduleId: input.scheduleId,
            expectedRevision: input.expectedRevision,
          },
        }),
      resumeSchedule: (input: {
        scheduleId: string;
        expectedRevision: number;
        requestId: string;
      }) =>
        changeSchedule({
          requestId: input.requestId,
          change: {
            action: "resume",
            scheduleId: input.scheduleId,
            expectedRevision: input.expectedRevision,
          },
        }),
      deleteSchedule: (input: {
        scheduleId: string;
        expectedRevision: number;
        requestId: string;
      }) =>
        changeSchedule({
          requestId: input.requestId,
          change: {
            action: "delete",
            scheduleId: input.scheduleId,
            expectedRevision: input.expectedRevision,
          },
        }),
      runScheduleNow: (input: {
        scheduleId: string;
        expectedRevision: number;
        requestId: string;
      }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const threadId = yield* scheduleThread(input.scheduleId);
            return yield* schedules.runNow(
              { ...input, threadId },
              restartScheduledThread(threadId),
            );
          }),
        ),
      listScheduleRuns: (input: { scheduleId: string }) =>
        runtime.runPromise(schedules.runs(input.scheduleId)),
      listScheduleProposals: (
        input: { threadId?: string; state?: ScheduleProposal["state"] } = {},
      ) =>
        runtime.runPromise(
          schedules
            .proposals(input.threadId)
            .pipe(
              Effect.map((values) =>
                values.filter((proposal) => !input.state || proposal.state === input.state),
              ),
            ),
        ),
      proposeScheduleChange: (input: ScheduleProposeInput) =>
        runtime.runPromise(schedules.propose(input)),
      approveScheduleProposal: (input: ScheduleDecisionInput) =>
        runtime.runPromise(schedules.decide(input, true)),
      rejectScheduleProposal: (input: ScheduleDecisionInput) =>
        runtime.runPromise(schedules.decide(input, false)),
      scheduleRequest: (input: { requestId: string }) =>
        runtime.runPromise(schedules.request(input.requestId)),
      subscribeSchedules: (listener: () => void) => schedules.subscribe(listener),
      scheduleSnapshot: () => runtime.runPromise(schedules.snapshot),
      githubIdentity: () => runtime.runPromise(github.identity()),
      githubQuery: (input: GitHubQuery) => runtime.runPromise(github.query(input)),
      skills: (cwd?: string) => runtime.runPromise(skills.catalog(cwd)),
      projects: () => runtime.runPromise(projects.list()),
      registerProject: (rootPath: string, name?: string) =>
        runtime.runPromise(
          projects.register({ rootPath, ...(name === undefined ? {} : { name }) }),
        ),
      workspaces: (projectId?: string) => runtime.runPromise(workspaces.list(projectId)),
      registerWorkspace: (projectId: string, cwd: string) =>
        runtime.runPromise(workspaces.register(projectId, cwd)),
      gitRepository: (workspaceId: string) => runtime.runPromise(git.repository(workspaceId)),
      gitBranches: (workspaceId: string) => runtime.runPromise(git.branches(workspaceId)),
      selectGitHubRemote: (projectId: string, remoteName: string | null, requestId?: string) =>
        runtime.runPromise(git.selectGitHubRemote(projectId, remoteName, requestId)),
      reviewStats: () => readReviewStats(paths.reviewLogPath),
      createWorktree: (input: CreateWorktreeInput) => runtime.runPromise(worktrees.create(input)),
      listWorktrees: (projectId: string) => runtime.runPromise(worktrees.list(projectId)),
      reconcileWorktrees: (projectId: string) => runtime.runPromise(worktrees.reconcile(projectId)),
      removeWorktree: (workspaceId: string, requestId: string) =>
        runtime.runPromise(worktrees.remove(workspaceId, requestId)),
      models: () => runtime.runPromise(models.list),
      threads: (workspaceId?: string, includeArchived?: boolean) =>
        runtime.runPromise(threads.list(workspaceId, includeArchived)),
      createThread: (
        workspaceId: string | null,
        requestId?: string,
        configuration?: CreateThreadConfiguration,
      ) => runtime.runPromise(threads.create(workspaceId, requestId, configuration)),
      threadMetadata: (id: string) => runtime.runPromise(threads.get(id)),
      openThread: (id: string) => runtime.runPromise(threads.open(id)),
      configureSandbox: (id: string, mode: SandboxMode) =>
        runtime.runPromise(threads.configureSandbox(id, mode)),
      decideApproval: (id: string, requestId: string, approved: boolean, reuse?: "call" | "run") =>
        runtime.runPromise(threads.decideApproval(id, requestId, approved, reuse)),
      renameThread: (id: string, title: string) => runtime.runPromise(threads.rename(id, title)),
      archiveThread: (id: string, archived: boolean) =>
        runtime.runPromise(threads.archive(id, archived)),
      deleteThread: (id: string) =>
        runtime.runPromise(
          Effect.gen(function* () {
            yield* scheduler.interrupt(id);
            yield* threads.remove(id);
          }),
        ),
      moveThread: (id: string, projectId: string | null) =>
        runtime.runPromise(threads.move(id, projectId)),
      configureThread: (id: string, provider: string, modelId: string, level: ThinkingLevel) =>
        runtime.runPromise(threads.configure(id, provider, modelId, level)),
      submit: (
        id: string,
        prompt: string,
        requestId?: string,
        images?: readonly ImageAttachment[],
      ) => runtime.runPromise(threads.submit(id, prompt, requestId, images)),
      operation: (id: string, operationId: string) =>
        runtime.runPromise(threads.operation(id, operationId)),
      operationByRequest: (id: string, requestId: string) =>
        runtime.runPromise(threads.operationByRequest(id, requestId)),
      recovery: (id: string) => runtime.runPromise(threads.recovery(id)),
      enqueueTask: (id: string, kind: string, input: JsonValue, requestId: string) =>
        runtime.runPromise(threads.enqueueTask(id, kind, input, requestId)),
      task: (id: string, taskId: string) => runtime.runPromise(threads.task(id, taskId)),
      stop: (id: string) => runtime.runPromise(threads.stop(id)),
      resume: (id: string) => runtime.runPromise(threads.resume(id)),
      compact: (id: string) => runtime.runPromise(threads.compact(id)),
      subagent: (id: string, command: SubagentCommand, requestId: string) =>
        runtime.runPromise(threads.subagent(id, command, requestId)),
      unloadSkill: (id: string, name: string) => runtime.runPromise(threads.unloadSkill(id, name)),
      subscribe: (
        id: string,
        listener: Parameters<typeof threads.subscribe>[1],
        onError: (message: string) => void,
        path?: string,
      ) => runtime.runPromise(threads.subscribe(id, listener, onError, path)),
      subscribeLibrary: (listener: () => void) => catalog.subscribe(listener),
      close: () =>
        (closing ??= (async () => {
          try {
            await runtime.runPromise(scheduler.stop);
          } finally {
            await runtime.dispose();
          }
        })()),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export type CoreClient = Awaited<ReturnType<typeof createCore>>;
