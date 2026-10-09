import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId, SubmissionId } from "@eta/agent";
import { Schema } from "effect";
import type { OperationResult, RecoveryState } from "../../agent/protocol.ts";
import { CoreError } from "../errors.ts";
import type { ThreadRuntime } from "../runtime/index.ts";

const OperationId = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ToolIntent = Schema.Struct({
  phase: Schema.Literal("execute"),
  replay: Schema.Literals(["safe", "unsafe"]),
});
const ToolInput = Schema.Struct({ assistant: Schema.Number, callId: Schema.String });

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
    operationId: String(receipt.id),
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
  let unsafeTool = false;
  for (const { record } of inspection.tasks) {
    if (record.kind !== "pi.tool" || !Schema.is(ToolIntent)(record.state.checkpoint)) continue;
    if (record.state.checkpoint.replay !== "safe" || !Schema.is(ToolInput)(record.input)) {
      unsafeTool = true;
      break;
    }
    const input = record.input;
    const entry = await runtime.storage.entry(input.assistant as EntryId, BACKGROUND_CONTEXT);
    const call = entry?.entry.model
      ?.flatMap((message) => (message.role === "assistant" ? message.content : []))
      .find((part) => part.type === "toolCall" && part.id === input.callId);
    const conversation = await runtime.harness.conversation(
      record.conversationId,
      BACKGROUND_CONTEXT,
    );
    const agent = await conversation?.agent(BACKGROUND_CONTEXT);
    if (
      call?.type !== "toolCall" ||
      agent?.tools.find((tool) => tool.name === call.name)?.replay !== "safe"
    ) {
      unsafeTool = true;
      break;
    }
  }
  return {
    required: runtime.recoveryRequired,
    pending: await runtime.hasWork(),
    unsafeTool,
    blockedTasks: inspection.tasks.flatMap(({ record, state }) =>
      state.kind === "blocked"
        ? [{ taskId: String(record.id), kind: record.kind, reason: state.reason }]
        : [],
    ),
  };
}
