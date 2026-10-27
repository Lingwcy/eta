import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@eta/agent";
import type { Cursor, EntryId, SubmissionId } from "@eta/agent";
import { Schema } from "effect";
import type { OperationResult, RecoveryState } from "../../agent/protocol.ts";
import { CoreError } from "../errors.ts";
import type { ThreadRuntime } from "../runtime/index.ts";
import { hasForegroundWork } from "../runtime/recovery.ts";
import { readOperationOrigin } from "./origin.ts";

const OperationId = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ToolIntent = Schema.Struct({
  phase: Schema.Literal("execute"),
  replay: Schema.Literals(["safe", "unsafe"]),
});
const ToolInput = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literal("model")),
  assistant: Schema.Number,
  callId: Schema.String,
});
const NestedToolInput = Schema.Struct({
  kind: Schema.Literal("nested"),
  parent: Schema.String,
  parentCallId: Schema.String,
  key: Schema.String,
  call: Schema.Struct({
    type: Schema.Literal("toolCall"),
    id: Schema.String,
    name: Schema.NonEmptyString,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  }),
});

/** An older input remains addressable after later turns and process restarts. */
export async function readOperation(
  runtime: ThreadRuntime,
  operationId: string,
): Promise<OperationResult> {
  let id: number;
  try {
    id = Schema.decodeUnknownSync(OperationId)(operationId);
  } catch {
    throw new CoreError({ code: "InvalidInput", message: "执行记录标识无效" });
  }
  const receipt = await runtime.storage.submission(id as SubmissionId, BACKGROUND_CONTEXT);
  if (!receipt || receipt.conversationId !== runtime.conversation.id || receipt.type !== "input")
    throw new CoreError({ code: "NotFound", message: "执行记录不存在" });
  const input =
    receipt.entry === undefined
      ? undefined
      : await runtime.storage.entry(receipt.entry, BACKGROUND_CONTEXT);
  const answer =
    receipt.answer === undefined
      ? undefined
      : await runtime.storage.entry(receipt.answer, BACKGROUND_CONTEXT);
  const messages = answer?.entry.model ?? [];
  const origin = receipt.requestId?.startsWith("subagent-report:")
    ? await readOperationOrigin(runtime.storage, receipt)
    : undefined;
  const status =
    receipt.status === "done"
      ? "completed"
      : receipt.status === "unanswered"
        ? receipt.reason === "aborted"
          ? "aborted"
          : "failed"
        : runtime.recoveryRequired
          ? "paused"
          : receipt.status === "queued"
            ? "queued"
            : "running";
  return {
    ...(input?.entry.model?.some((message) => message.role === "user")
      ? {
          inputEntryId: `${receipt.entry}:${input.entry.model.findIndex((message) => message.role === "user")}`,
        }
      : {}),
    operationId: String(receipt.id),
    ...(origin !== undefined ? { originOperationId: origin } : {}),
    kind: "run",
    startedAt: input?.entry.model?.[0]?.timestamp ?? runtime.ref.metadata.createdAt,
    status,
    messages,
    ...(receipt.status === "done" && messages[0]?.timestamp !== undefined
      ? { endedAt: messages[0].timestamp }
      : {}),
    ...(receipt.status === "unanswered"
      ? { error: typeof receipt.detail === "string" ? receipt.detail : receipt.reason }
      : {}),
  };
}

export async function readRecovery(runtime: ThreadRuntime): Promise<RecoveryState> {
  const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
  const queuedOnly =
    inspection.submissions.length > 0 &&
    inspection.submissions.every((submission) => submission.status === "queued") &&
    !hasForegroundWork({ tasks: inspection.tasks, submissions: [] });
  let failedTurn = false;
  if (
    queuedOnly &&
    !(await runtime.harness.snapshot(LiveDoc, runtime.conversation.id, BACKGROUND_CONTEXT))?.run
  ) {
    let cursor: Cursor | undefined;
    search: do {
      const page = await runtime.storage.scanSubmissions(
        { conversationId: runtime.conversation.id, order: "descending" },
        64,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const receipt of page.items) {
        if (receipt.type !== "input") continue;
        if (receipt.status === "unanswered") {
          failedTurn = receipt.reason !== "aborted";
          break search;
        }
        if (
          receipt.status === "done" &&
          receipt.answer !== undefined &&
          (await runtime.storage.entry(receipt.answer, BACKGROUND_CONTEXT))
        )
          break search;
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  let unsafeTool = false;
  for (const { record } of inspection.tasks) {
    if (record.kind !== "pi.tool" || !Schema.is(ToolIntent)(record.state.checkpoint)) continue;
    if (record.state.checkpoint.replay !== "safe") {
      unsafeTool = true;
      break;
    }
    let toolName: string | undefined;
    if (Schema.is(ToolInput)(record.input)) {
      const input = record.input;
      const entry = await runtime.storage.entry(input.assistant as EntryId, BACKGROUND_CONTEXT);
      const call = entry?.entry.model
        ?.flatMap((message) => (message.role === "assistant" ? message.content : []))
        .find((part) => part.type === "toolCall" && part.id === input.callId);
      if (call?.type === "toolCall") toolName = call.name;
    } else if (Schema.is(NestedToolInput)(record.input)) {
      toolName = record.input.call.name;
    }
    if (toolName === undefined) {
      unsafeTool = true;
      break;
    }
    const conversation = await runtime.harness.conversation(
      record.conversationId,
      BACKGROUND_CONTEXT,
    );
    const agent = await conversation?.agent(BACKGROUND_CONTEXT);
    if (agent?.tools.find((tool) => tool.name === toolName)?.replay !== "safe") {
      unsafeTool = true;
      break;
    }
  }
  return {
    required: runtime.recoveryRequired,
    pending: hasForegroundWork(inspection),
    queuedOnly,
    ...(failedTurn ? { failedTurn: true } : {}),
    unsafeTool,
    blockedTasks: inspection.tasks.flatMap(({ record, state }) =>
      state.kind === "blocked"
        ? [{ taskId: String(record.id), kind: record.kind, reason: state.reason }]
        : [],
    ),
  };
}
