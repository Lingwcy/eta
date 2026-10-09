import { messageText } from "../../message-text.ts";
import { AssistantEntry, LiveDoc, defineTask } from "@eta/agent";
import type { EntryId, TaskId } from "@eta/agent";
import { imageInput } from "../../../images/content.ts";
import { SubagentsDoc, isDescendant } from "./state.ts";
import type { SubagentRuntime } from "./runtime.ts";

export function createSubagentTasks({
  options,
  settings,
  state,
  commit,
  gate,
  notify,
}: SubagentRuntime) {
  const Anchor = defineTask<null, { phase: "done" }, null>({
    name: "eta.subagent-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: (_task, runtime, context) =>
        runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        ),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  type Input = {
    path: string;
    message: string;
    images?: { type: "image"; data: string; mimeType: string; name?: string; note?: string }[];
  };
  type State =
    | { phase: "deliver" }
    | { phase: "join"; answer: EntryId }
    | { phase: "report"; report?: string };
  const Reporter = defineTask<Input, State, null>({
    name: "eta.subagent-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, context) => {
        try {
          await gate(async () => {
            const policy = await settings();
            return commit(
              runtime.conversationId,
              async (tx) => {
                const doc = await tx.doc(SubagentsDoc);
                const child = doc.agents.find((agent) => agent.path === task.input.path)!;
                if (options.ready?.() === false || doc.stopping || child.stopping || child.paused)
                  return false;
                if (child.active.includes(task.id)) return true;
                if (
                  child.active.length === 0 &&
                  doc.agents.filter(
                    (agent) =>
                      agent.active.length > 0 &&
                      !doc.waiters?.some(
                        (waiter) => waiter.conversationId === agent.conversationId,
                      ),
                  ).length >= policy.maxConcurrent
                )
                  return false;
                child.active.push(task.id);
                child.pending = child.pending.filter((id) => id !== task.id);
                delete child.submissionFor;
                delete child.output;
                child.status = "running";
                return true;
              },
              context,
            );
          }, context);
          const child = (await state(context))!.agents.find(
            (agent) => agent.path === task.input.path,
          )!;
          const conversation = (await runtime.conversation(child.conversationId, context))!;
          const submission = await conversation.submit(
            {
              type: "input",
              content: imageInput(task.input.message, task.input.images),
              whenBusy: "steer",
              requestId: `subagent:${task.id}`,
            },
            context,
          );
          await runtime.commit(async (tx) => {
            const record = (await tx.doc(SubagentsDoc)).agents.find(
              (agent) => agent.path === child.path,
            )!;
            record.submissionFor = task.id;
          }, context);
          const result = await submission.wait(context);
          await runtime.commit(async (tx) => {
            const record = (await tx.doc(SubagentsDoc)).agents.find(
              (agent) => agent.path === child.path,
            )!;
            record.active = record.active.filter((id) => id !== task.id);
            let report: string | undefined;
            if (result.status === "unanswered") {
              record.status = result.reason === "aborted" && !record.error ? "stopped" : "failed";
              if (result.reason !== "aborted" || record.error) {
                record.error ??= typeof result.detail === "string" ? result.detail : result.reason;
                report = `[${child.path} failed] ${record.error}`;
              }
            } else if (result.type === "input") {
              // Waiting for descendants must not reserve an execution slot: they may be queued behind us.
              record.settling ??= [];
              record.settling.push(task.id);
              record.status = "running";
              return {
                status: "running",
                checkpoint: { phase: "join", answer: result.answer },
              };
            }
            if (report) {
              record.settling ??= [];
              record.settling.push(task.id);
            }
            return {
              status: "running",
              checkpoint: { phase: "report", ...(report ? { report } : {}) },
            };
          }, context);
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          await runtime.commit(async (tx) => {
            const child = (await tx.doc(SubagentsDoc)).agents.find(
              (child) => child.path === task.input.path,
            )!;
            child.active = child.active.filter((id) => id !== task.id);
            child.pending = child.pending.filter((id) => id !== task.id);
            child.status = "failed";
            child.settling ??= [];
            if (!child.settling.includes(task.id)) child.settling.push(task.id);
            child.error = error instanceof Error ? error.message : "子智能体执行失败";
            return {
              status: "running",
              checkpoint: { phase: "report", report: `[${child.path} failed] ${child.error}` },
            };
          }, context);
        }
      },
      join: async (task, runtime, context) => {
        while (true) {
          await gate(async () => {
            const doc = (await state(context))!;
            return (
              !doc.agents.some(
                (child) =>
                  isDescendant(child, task.input.path, doc.agents) &&
                  (child.active.length || child.pending.length || child.settling?.length),
              ) && !doc.agents.find((child) => child.path === task.input.path)?.steering?.length
            );
          }, context);
          const child = (await state(context))!.agents.find(
            (child) => child.path === task.input.path,
          )!;
          const conversation = (await runtime.conversation(child.conversationId, context))!;
          await conversation.waitForIdle(context);
          let retry = false;
          await runtime.commit(async (tx) => {
            const record = (await tx.doc(SubagentsDoc)).agents.find(
              (child) => child.path === task.input.path,
            )!;
            // Steering can arrive between waitForIdle and this commit; capture only the settled answer.
            if (record.steering?.length || (await tx.doc(LiveDoc, child.conversationId)).run) {
              retry = true;
              return;
            }
            let report: string | undefined;
            if (!record.reported.includes(task.state.checkpoint.answer)) {
              record.reported.push(task.state.checkpoint.answer);
              // Descendant reports can produce a newer synthesis than the original answer.
              const latest = (
                await tx.scanEntries({ conversationId: child.conversationId }, 64)
              ).items.find((entry) => AssistantEntry.is(entry));
              const answer =
                latest ?? (await tx.entry(AssistantEntry, task.state.checkpoint.answer));
              const text =
                answer?.model
                  ?.flatMap((message) =>
                    message.role === "assistant" ? [messageText(message)] : [],
                  )
                  .join("\n") ?? "";
              report = `[${child.path} completed] ${text}`;
              record.output = text;
            }
            record.status = record.active.length
              ? "running"
              : record.pending.length
                ? "queued"
                : "completed";
            return {
              status: "running",
              checkpoint: { phase: "report", ...(report ? { report } : {}) },
            };
          }, context);
          if (!retry) return;
        }
      },
      report: async (task, runtime, context) => {
        if (task.state.checkpoint.report) {
          const child = (await state(context))!.agents.find(
            (child) => child.path === task.input.path,
          )!;
          const event = task.state.checkpoint.report.startsWith(`[${child.path} failed] `)
            ? "failed"
            : "completed";
          const prefix = `[${child.path} ${event}] `;
          const report = task.state.checkpoint.report;
          await notify(
            child,
            event,
            report.startsWith(prefix) ? report.slice(prefix.length) : report,
            String(task.id),
            context,
          );
        }
        await runtime.commit(async (tx) => {
          const child = (await tx.doc(SubagentsDoc)).agents.find(
            (child) => child.path === task.input.path,
          )!;
          child.settling = child.settling?.filter((id) => id !== task.id);
          if (child.status !== "failed" && child.status !== "stopped")
            child.status =
              child.active.length || child.settling?.length
                ? "running"
                : child.pending.length
                  ? "queued"
                  : "completed";
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const child = (await tx.doc(SubagentsDoc)).agents.find(
          (agent) => agent.path === task.input.path,
        );
        if (child) {
          child.active = child.active.filter((id) => id !== task.id);
          child.pending = child.pending.filter((id) => id !== task.id);
          child.settling = child.settling?.filter((id) => id !== task.id);
          if (!child.active.length && !child.pending.length && !child.settling?.length)
            child.status = "stopped";
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });

  const Steering = defineTask<
    Input & { expected: TaskId; requestId: string },
    { phase: "deliver" },
    null
  >({
    name: "eta.subagent-steering",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, context) => {
        await gate(async () => {
          const child = (await state(context))!.agents.find(
            (child) => child.path === task.input.path,
          )!;
          return (
            child.submissionFor === task.input.expected ||
            ![...child.active, ...child.pending, ...(child.settling ?? [])].includes(
              task.input.expected,
            )
          );
        }, context);
        const child = (await state(context))!.agents.find(
          (child) => child.path === task.input.path,
        )!;
        if ([...child.active, ...(child.settling ?? [])].includes(task.input.expected)) {
          const conversation = (await runtime.conversation(child.conversationId, context))!;
          await conversation.submit(
            {
              type: "input",
              content: imageInput(task.input.message, task.input.images),
              whenBusy: "steer",
              requestId: `subagent-steer:${task.input.requestId}`,
            },
            context,
          );
        }
        await runtime.commit(async (tx) => {
          const child = (await tx.doc(SubagentsDoc)).agents.find(
            (child) => child.path === task.input.path,
          )!;
          child.steering = child.steering?.filter((id) => id !== task.id);
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const child = (await tx.doc(SubagentsDoc)).agents.find(
          (child) => child.path === task.input.path,
        )!;
        child.steering = child.steering?.filter((id) => id !== task.id);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });

  const Timeout = defineTask<
    { path: string; expected: TaskId; deadline: number },
    { phase: "notify" },
    null
  >({
    name: "eta.subagent-timeout",
    version: 1,
    initial: () => ({ phase: "notify" }),
    phases: {
      notify: async (task, runtime, context) => {
        const finished = async () => {
          const child = (await state(context))?.agents.find(
            (child) => child.path === task.input.path,
          );
          return (
            !child ||
            child.timeoutTask !== task.id ||
            child.stopping ||
            ![...child.active, ...child.pending, ...(child.settling ?? [])].includes(
              task.input.expected,
            )
          );
        };
        // Persisting an absolute deadline keeps recovery from restarting the entire timeout.
        const settled = await gate(
          finished,
          context,
          Math.max(0, task.input.deadline - Date.now()),
        );
        if (!settled && !(await finished())) {
          const child = (await state(context))!.agents.find(
            (child) => child.path === task.input.path,
          )!;
          await notify(
            child,
            "timeout",
            `The task is still ${child.paused ? "paused" : child.status}; it has not been cancelled. ${child.progress?.message ?? "No progress update yet."}`,
            String(task.id),
            context,
          );
        }
        await runtime.commit(async (tx) => {
          const child = (await tx.doc(SubagentsDoc)).agents.find(
            (child) => child.path === task.input.path,
          )!;
          if (child.timeoutTask === task.id) delete child.timeoutTask;
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const child = (await tx.doc(SubagentsDoc)).agents.find(
          (child) => child.path === task.input.path,
        )!;
        if (child.timeoutTask === task.id) delete child.timeoutTask;
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });

  return { Anchor, Reporter, Steering, Timeout };
}
