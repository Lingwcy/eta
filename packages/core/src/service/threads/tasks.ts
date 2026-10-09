import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@eta/agent";
import type { Task, TaskId } from "@eta/agent";
import type { JsonValue } from "@earendil-works/chord";
import { Schema } from "effect";
import { CoreError } from "../errors.ts";
import type { ThreadRuntime } from "../runtime/index.ts";

const Requests = defineDoc<{
  requests: Record<string, { id: TaskId; kind: string; input: JsonValue }>;
}>({
  kind: "eta.host-tasks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: {} }),
});
const Identifier = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

/** Admission and its request mapping commit together; the host must register the stable task kind first. */
export async function enqueueTask(
  runtime: ThreadRuntime,
  kind: string,
  input: JsonValue,
  requestId: string,
) {
  if (!requestId || requestId.length > 256)
    throw new CoreError({ code: "InvalidInput", message: "任务请求标识无效" });
  if (runtime.disposed) throw new CoreError({ code: "RuntimeClosing", message: "会话正在关闭" });
  const taskId = await runtime.conversation.commit(async (tx) => {
    const requests = (await tx.doc(Requests, runtime.conversation.id)).requests;
    const key = `request:${requestId}`;
    const existing = requests[key];
    if (existing) {
      if (existing.kind !== kind || JSON.stringify(existing.input) !== JSON.stringify(input))
        throw new CoreError({ code: "InvalidInput", message: "任务请求标识已绑定其他输入" });
      return existing.id;
    }
    if (runtime.recoveryRequired)
      throw new CoreError({ code: "RecoveryRequired", message: "请先恢复或停止未完成任务" });
    const task = runtime.registry.snapshot().task(kind);
    if (!task) throw new CoreError({ code: "InvalidInput", message: "宿主任务未注册" });
    // Registry snapshots erase task generics. Each definition validates its JSON input in initial().
    const definition = task as Task<JsonValue, { phase: string }, JsonValue, object>;
    const id = await tx.createTask(definition, input, {
      ownership: { kind: "conversation" },
      background: true,
    });
    requests[key] = { id, kind, input };
    return id;
  }, BACKGROUND_CONTEXT);
  if (!runtime.recoveryRequired) runtime.harness.resume();
  return { taskId: String(taskId), kind };
}

export async function readTask(runtime: ThreadRuntime, taskId: string) {
  let id: number;
  try {
    id = Schema.decodeUnknownSync(Identifier)(taskId);
  } catch {
    throw new CoreError({ code: "InvalidInput", message: "任务标识无效" });
  }
  const record = await runtime.storage.task(id as TaskId, BACKGROUND_CONTEXT);
  if (!record || record.conversationId !== runtime.conversation.id)
    throw new CoreError({ code: "NotFound", message: "任务不存在" });
  return { taskId, kind: record.kind, version: record.version, state: record.state };
}
