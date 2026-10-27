import { toolIntents } from "@eta/agent/tools";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { CompactionEntry, ToolResultEntry, UserEntry } from "@eta/agent";
import type { AgentState, ConversationView, Cursor, LiveState, SubmissionRecord } from "@eta/agent";
import { Context, Effect, Layer } from "effect";
import type { SnapshotResponse } from "../../agent/protocol.ts";
import { adapter, CoreError } from "../errors.ts";
import type { ThreadRuntime } from "../runtime/index.ts";
import { SubagentsDoc, SubagentEventEntry } from "../../agent/extension/subagent/index.ts";
import { SkillsDoc, skillSummary } from "../skills/extension.ts";
import { AgentModeDoc } from "../runtime/codemode.ts";

export class ObservationService extends Context.Service<
  ObservationService,
  {
    snapshot(runtime: ThreadRuntime): Effect.Effect<SnapshotResponse, CoreError>;
    subscribe(
      runtime: ThreadRuntime,
      onSnapshot: (value: SnapshotResponse) => void | Promise<void>,
      onError: (message: string) => void,
    ): Effect.Effect<() => void, CoreError>;
  }
>()("eta/core/service/observation/ObservationService") {
  static readonly layer = Layer.succeed(
    ObservationService,
    ObservationService.of({
      snapshot: (runtime) =>
        adapter("无法读取会话快照", async () => {
          const watch = await runtime.conversation.watch(BACKGROUND_CONTEXT);
          try {
            return project(runtime, watch.value);
          } finally {
            await watch.stop();
          }
        }),
      subscribe: (runtime, onSnapshot, onError) =>
        adapter("无法订阅会话", async () => {
          const watch = await runtime.conversation.watch(BACKGROUND_CONTEXT);
          let stopped = false;
          let delivery: Promise<void> | undefined;
          let pending: ConversationView | undefined;
          const stop = () => {
            if (stopped) return;
            stopped = true;
            pending = undefined;
            runtime.watches.delete(watch);
            runtime.changes.delete(changed);
            void watch.stop().catch(() => {});
          };
          const send = (view: ConversationView) => {
            if (stopped || runtime.disposed) return;
            pending = view;
            if (delivery) return;
            // Wait for the consumer; coalesce full snapshots while a transport write is stalled.
            delivery = (async () => {
              while (pending && !stopped && !runtime.disposed) {
                const current = pending;
                pending = undefined;
                const value = await project(runtime, current);
                if (!stopped && !runtime.disposed) await onSnapshot(value);
              }
            })()
              .catch((error: unknown) => {
                if (!stopped && !runtime.disposed) {
                  stop();
                  try {
                    onError(error instanceof Error ? error.message : "观察失败");
                  } catch {}
                }
              })
              .finally(() => {
                delivery = undefined;
                if (pending && !stopped && !runtime.disposed) send(pending);
              });
          };
          runtime.watches.add(watch);
          const changed = () => send(watch.value);
          runtime.changes.add(changed);
          // Queue the initial revision before start drains buffered commits; one ordered delivery line.
          send(watch.value);
          watch.start(async (view) => {
            send(view);
          });
          // Return the disposer immediately; a streaming producer must not delay unwatch until idle.
          return stop;
        }),
    }),
  );
}

/** Read receipts from storage rather than remembering a run result in the Electron process. */
async function project(runtime: ThreadRuntime, view: ConversationView): Promise<SnapshotResponse> {
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  const agent = (view.docs["pi.agent"] ?? {}) as AgentState;
  let history = view.entries;
  if (view.entries.some((entry) => entry.head !== undefined)) {
    const maxEntryId = view.entries.reduce(
      (highest, entry) => (entry.id > highest ? entry.id : highest),
      view.entries[0]!.id,
    );
    const entries: (typeof view.entries)[number][] = [];
    let pageCursor: Cursor | undefined;
    do {
      const page = await runtime.conversation.entries(
        { maxEntryId },
        200,
        pageCursor,
        BACKGROUND_CONTEXT,
      );
      entries.push(...page.items);
      pageCursor = page.next;
    } while (pageCursor !== undefined);
    history = entries.reverse();
  }
  const receipts: SubmissionRecord[] = [];
  const reports = new Set<number>();
  const inputs = new Set<number>();
  // Fork history includes ancestor entries, whose submission receipts belong to the ancestor.
  const sources = new Set([
    runtime.conversation.id,
    ...history.map((entry) => entry.conversationId),
  ]);
  for (const conversationId of sources) {
    let cursor: Cursor | undefined;
    do {
      const page = await runtime.storage.scanSubmissions(
        { conversationId },
        200,
        cursor,
        BACKGROUND_CONTEXT,
      );
      if (conversationId === runtime.conversation.id) receipts.push(...page.items);
      for (const receipt of page.items) {
        if (receipt.requestId?.startsWith("subagent-report:") && receipt.entry !== undefined)
          reports.add(receipt.entry);
        else if (receipt.type === "input" && receipt.entry !== undefined) inputs.add(receipt.entry);
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  const terminal = receipts.findLast(
    (receipt) =>
      receipt.type === "input" &&
      ((receipt.status === "done" && history.some((entry) => entry.id === receipt.answer)) ||
        (receipt.status === "unanswered" && !live.run?.inputs.includes(receipt.id))),
  );
  // Automatic reports remain model context, but are not messages authored by the user.
  const transcript = history
    .filter(
      (entry) =>
        !CompactionEntry.is(entry) &&
        !SubagentEventEntry.is(entry) &&
        !reports.has(entry.id) &&
        !(UserEntry.is(entry) && entry.byTaskId !== undefined && !inputs.has(entry.id)),
    )
    .flatMap((entry) =>
      (entry.model ?? [])
        .filter((message) => message.role !== "system")
        .map((message, index) => ({
          id: `${entry.id}:${index}`,
          type: "message" as const,
          message,
          ...(message.role === "toolResult" &&
          ToolResultEntry.is(entry) &&
          entry.data?.diagnostics.some((diagnostic) => diagnostic.code === "aborted")
            ? { toolStatus: "stopped" as const }
            : {}),
        })),
    );
  const failed = terminal?.status === "unanswered" && terminal.reason !== "aborted";
  // 1.0 receipts do not contain wall-clock times; use persisted transcript timestamps, not reload time.
  const timestamp =
    transcript.findLast(({ message }) => message.timestamp !== undefined)?.message.timestamp ??
    runtime.ref.metadata.createdAt;
  const entryTime = (id: number | undefined) =>
    history.find((entry) => entry.id === id)?.model?.[0]?.timestamp ??
    runtime.ref.metadata.createdAt;
  const active = receipts.find((receipt) => receipt.id === live.run?.inputs[0]);
  const subagents = await runtime.harness.snapshot(SubagentsDoc, BACKGROUND_CONTEXT);
  const waiting = subagents?.waiters?.some(
    (waiter) =>
      waiter.conversationId === runtime.conversation.id && waiter.taskId === live.run?.taskId,
  );
  const approvals = await runtime.approvals.list();
  const snapshot: SnapshotResponse["snapshot"] = {
    sandbox: await runtime.sandbox(),
    approvals,
    approvalHistory: await runtime.approvals.history(),
    subagents: (await runtime.subagents.list()).map((child) =>
      runtime.recoveryRequired && (child.status === "running" || child.status === "queued")
        ? { ...child, status: "paused" as const }
        : child,
    ),
    activeSkills:
      (
        await runtime.harness.snapshot(SkillsDoc, runtime.conversation.id, BACKGROUND_CONTEXT)
      )?.active.map(skillSummary) ?? [],
    configuration: {
      model: agent.model ?? { provider: "", modelId: "" },
      thinkingLevel: agent.thinkingLevel ?? "off",
      agentMode:
        (await runtime.harness.snapshot(AgentModeDoc, runtime.conversation.id, BACKGROUND_CONTEXT))
          ?.mode ?? "standard",
    },
    transcript,
    toolIntents: toolIntents(
      history.flatMap((entry) => [...(entry.model ?? [])]),
      live.generation?.message,
    ),
    operation: live.run
      ? {
          id: String(live.run.inputs[0] ?? ""),
          kind: "run",
          startedAt: entryTime(active?.entry),
          status: "running",
          ...(waiting ? { waitingForSubagents: true } : {}),
          ...(approvals.length ? { waitingForApproval: true } : {}),
          fromTipId: null,
          runningTools: [...(live.tools ?? []), ...(live.nestedTools ?? [])]
            .filter((tool) => tool.status !== "done" || "parentCallId" in tool)
            .map((tool) => {
              const call = transcript
                .flatMap(({ message }) => (message.role === "assistant" ? message.content : []))
                .find((part) => part.type === "toolCall" && part.id === tool.callId);
              const output = tool.output ?? ("summary" in tool ? tool.summary?.error : undefined);
              return {
                status:
                  tool.status === "done"
                    ? "settled"
                    : approvals.some((request) => request.toolTaskId === String(tool.taskId))
                      ? "waiting"
                      : tool.status === "pending"
                        ? "pending"
                        : "running",
                ...(tool.description ? { description: tool.description } : {}),
                ...("summary" in tool ? { isError: tool.summary?.isError } : {}),
                toolCallId: tool.callId,
                ...(tool.taskId === undefined ? {} : { taskId: String(tool.taskId) }),
                ...("parentCallId" in tool
                  ? {
                      parentToolCallId: tool.parentCallId,
                      parentTaskId: String(tool.parentTaskId),
                    }
                  : {}),
                toolName: tool.name,
                args:
                  "arguments" in tool
                    ? tool.arguments
                    : call?.type === "toolCall"
                      ? call.arguments
                      : {},
                ...(output === undefined && tool.details === undefined
                  ? {}
                  : {
                      result: {
                        content: output === undefined ? [] : [{ type: "text", text: output }],
                        details: tool.details,
                      },
                    }),
              };
            }),
          ...(live.generation?.message && !waiting
            ? { streamingMessage: live.generation.message }
            : {}),
          ...(live.generation?.retry
            ? { retry: { attempt: live.generation.attempt, maxAttempts: 4 } }
            : {}),
          ...(live.generation?.deferred ? { deferred: live.generation.deferred } : {}),
        }
      : null,
    lastResult: terminal
      ? {
          operationId: String(terminal.id),
          kind: "run",
          startedAt: entryTime(terminal.entry),
          endedAt: terminal.status === "done" ? entryTime(terminal.answer) : timestamp,
          fromTipId: null,
          tipId: null,
          status: terminal.status === "done" ? "completed" : failed ? "failed" : "aborted",
          ...(failed
            ? {
                error: {
                  message:
                    typeof terminal.detail === "string"
                      ? terminal.detail
                      : JSON.stringify(terminal.detail ?? terminal.reason),
                },
              }
            : {}),
        }
      : null,
    faulted: !!runtime.error,
    recoveryRequired: runtime.recoveryRequired,
    compacting: !!live.compactions?.length,
    ...(runtime.error || runtime.blockedReason
      ? { blockedReason: runtime.error ?? runtime.blockedReason }
      : {}),
  };
  return {
    // Detach mutable containers without encoding and reallocating large image/history strings.
    snapshot: copySnapshot(snapshot),
    contextTokens: estimateContextTokens(view.entries.flatMap((entry) => entry.model ?? [])).tokens,
  };
}

/** Persisted payloads are JSON; copy their containers and omit optional object fields. */
function copySnapshot<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => copySnapshot(item)) as T;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const copied = copySnapshot(item);
    if (key === "__proto__") {
      Object.defineProperty(result, key, {
        value: copied,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else result[key] = copied;
  }
  return result as T;
}
