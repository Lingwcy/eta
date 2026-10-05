import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { CompactionEntry } from "@eta/agent";
import type { AgentState, ConversationView, Cursor, LiveState, SubmissionRecord } from "@eta/agent";
import { Context, Effect, Layer } from "effect";
import type { SnapshotResponse } from "../../../agent/protocol.ts";
import { adapter, DesktopServiceError } from "../errors.ts";
import type { ThreadRuntime } from "../runtime/index.ts";
import { SkillsDoc, skillSummary } from "../skills/extension.ts";

export class ObservationService extends Context.Service<
  ObservationService,
  {
    snapshot(runtime: ThreadRuntime): Effect.Effect<SnapshotResponse, DesktopServiceError>;
    subscribe(
      runtime: ThreadRuntime,
      onSnapshot: (value: SnapshotResponse) => void,
      onError: (message: string) => void,
    ): Effect.Effect<() => void, DesktopServiceError>;
  }
>()("eta/desktop/main/service/observation/ObservationService") {
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
          const send = (view: ConversationView) => {
            pending = view;
            if (delivery) return;
            // Full snapshots permit coalescing; never build an unbounded queue of token-sized updates.
            delivery = (async () => {
              while (pending && !stopped && !runtime.disposed) {
                const current = pending;
                pending = undefined;
                const value = await project(runtime, current);
                if (!stopped && !runtime.disposed) onSnapshot(value);
              }
            })()
              .catch((error: unknown) => {
                if (!stopped && !runtime.disposed) {
                  try {
                    onError(error instanceof Error ? error.message : "观察失败");
                  } catch {
                    stopped = true;
                    runtime.watches.delete(watch);
                    runtime.changes.delete(changed);
                    void watch.stop().catch(() => {});
                  }
                }
              })
              .finally(() => {
                delivery = undefined;
                if (pending && !stopped) send(pending);
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
          return () => {
            if (stopped) return;
            stopped = true;
            runtime.watches.delete(watch);
            runtime.changes.delete(changed);
            void watch.stop().catch(() => {});
          };
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
  let cursor: Cursor | undefined;
  do {
    const page = await runtime.storage.scanSubmissions(
      { conversationId: runtime.conversation.id },
      200,
      cursor,
      BACKGROUND_CONTEXT,
    );
    receipts.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const terminal = receipts.findLast(
    (receipt) =>
      receipt.type === "input" &&
      ((receipt.status === "done" && history.some((entry) => entry.id === receipt.answer)) ||
        (receipt.status === "unanswered" && !live.run?.inputs.includes(receipt.id))),
  );
  const transcript = history
    .filter((entry) => !CompactionEntry.is(entry))
    .flatMap((entry) =>
      (entry.model ?? [])
        .filter((message) => message.role !== "system")
        .map((message, index) => ({
          id: `${entry.id}:${index}`,
          type: "message" as const,
          message,
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
  const snapshot: SnapshotResponse["snapshot"] = {
    activeSkills:
      (
        await runtime.harness.snapshot(SkillsDoc, runtime.conversation.id, BACKGROUND_CONTEXT)
      )?.active.map(skillSummary) ?? [],
    configuration: {
      model: agent.model ?? { provider: "", modelId: "" },
      thinkingLevel: agent.thinkingLevel ?? "off",
    },
    transcript,
    operation: live.run
      ? {
          id: String(live.run.inputs[0] ?? ""),
          kind: "run",
          startedAt: entryTime(active?.entry),
          status: "running",
          fromTipId: null,
          runningTools: (live.tools ?? [])
            .filter((tool) => tool.status !== "done")
            .map((tool) => {
              const call = transcript
                .flatMap(({ message }) => (message.role === "assistant" ? message.content : []))
                .find((part) => part.type === "toolCall" && part.id === tool.callId);
              return {
                status: "running",
                toolCallId: tool.callId,
                toolName: tool.name,
                args: call?.type === "toolCall" ? call.arguments : {},
                ...(tool.output === undefined
                  ? {}
                  : {
                      result: {
                        content: [{ type: "text", text: tool.output }],
                        details: tool.details,
                      },
                    }),
              };
            }),
          ...(live.generation?.message ? { streamingMessage: live.generation.message } : {}),
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
    snapshot: JSON.parse(JSON.stringify(snapshot)) as SnapshotResponse["snapshot"],
    contextTokens: estimateContextTokens(view.entries.flatMap((entry) => entry.model ?? [])).tokens,
  };
}
