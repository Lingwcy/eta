import { createHash } from "node:crypto";
import type { JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, InboxDoc } from "@eta/agent";
import type { InboxItem, SubmissionId, UserInput } from "@eta/agent";
import type { InputMode, QueuedInput, WithdrawnInput } from "../../agent/protocol.ts";
import type { ImageAttachment } from "../../images/types.ts";
import type { ThreadRuntime } from "../runtime/index.ts";
import { CoreError } from "../errors.ts";

type InputRecord = {
  requestId: string;
  fingerprint: string;
  prompt?: string;
  skillsPrepared?: boolean;
  submittedAt: number;
  mode: InputMode;
  images: { name?: string; mimeType: string; note?: string }[];
  id?: number;
  recoverable?: boolean;
};

export const InputsDoc = defineDoc<{ records: InputRecord[] }>({
  kind: "eta.inputs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ records: [] }),
  checkpointWhen: () => false,
});

/** Keep full drafts out of the frequently read queue metadata; old cancellations hydrate only on take-back. */
export const RecoveryDoc = defineDocFamily<
  {
    prompt: string;
    content: JsonRepresentation<UserInput> | null;
    images: InputRecord["images"];
  },
  null
>({
  kind: "eta.input-recovery",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ prompt: "", content: null, images: [] }),
  checkpointWhen: () => false,
});

export const MAX_QUEUED_INPUTS = 32;
const MAX_QUEUE_BYTES = 32 * 1024 * 1024;

export function inputFingerprint(
  prompt: string,
  images: readonly ImageAttachment[] | undefined,
  mode: InputMode,
) {
  return createHash("sha256")
    .update(JSON.stringify({ prompt, images: images ?? [], mode }))
    .digest("hex");
}

export async function inputRecords(runtime: ThreadRuntime) {
  return (
    (await runtime.harness.snapshot(InputsDoc, runtime.conversation.id, BACKGROUND_CONTEXT))
      ?.records ?? []
  );
}

export async function checkQueueCapacity(runtime: ThreadRuntime, content: UserInput) {
  const items =
    (await runtime.harness.snapshot(InboxDoc, runtime.conversation.id, BACKGROUND_CONTEXT))
      ?.items ?? [];
  const inputs = items.filter((item) => item.mode !== "write");
  if (
    inputs.length >= MAX_QUEUED_INPUTS ||
    Buffer.byteLength(JSON.stringify(inputs)) + Buffer.byteLength(JSON.stringify(content)) >
      MAX_QUEUE_BYTES
  )
    throw new CoreError({ code: "Busy", message: "待处理消息已满，请等待或撤回消息后重试" });
}

export async function rememberInput(
  runtime: ThreadRuntime,
  record: InputRecord,
  content?: UserInput,
) {
  await runtime.conversation.commit(async (tx) => {
    const doc = await tx.doc(InputsDoc, runtime.conversation.id);
    const index = doc.records.findIndex((item) => item.requestId === record.requestId);
    const current = doc.records[index];
    const preview = {
      ...record,
      ...(record.prompt === undefined ? {} : { prompt: record.prompt.slice(0, 2000) }),
      images: record.images.map(({ name, mimeType }) => ({ ...(name ? { name } : {}), mimeType })),
    };
    if (index < 0) doc.records.push(preview);
    else {
      doc.records[index] = { ...current!, ...preview };
      if (current?.skillsPrepared) doc.records[index]!.skillsPrepared = true;
      if (current?.recoverable === false) {
        doc.records[index]!.recoverable = false;
        delete doc.records[index]!.prompt;
      }
    }
    if (content !== undefined && current?.recoverable !== false) {
      const recovery = await tx.doc(RecoveryDoc, runtime.conversation.id, record.requestId, null);
      recovery.prompt = record.prompt ?? payload(content, record.images).prompt;
      recovery.content = content as JsonRepresentation<UserInput>;
      recovery.images = record.images;
      doc.records[index < 0 ? doc.records.length - 1 : index]!.recoverable = true;
    }
  }, BACKGROUND_CONTEXT);
}

function payload(content: UserInput, images: InputRecord["images"]) {
  if (typeof content === "string") return { prompt: content, images: [] };
  let index = 0;
  return {
    prompt: content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    images: content.flatMap((part) =>
      part.type === "image" ? [{ ...part, ...images[index++] }] : [],
    ),
  };
}

export function projectQueuedInputs(
  records: readonly InputRecord[],
  items: readonly InboxItem[],
  receipts: readonly {
    id: number;
    status: string;
    reason?: string;
    requestId?: string;
    entry?: number;
  }[],
): QueuedInput[] {
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const byRequest = new Map(
    receipts
      .filter((receipt) => receipt.requestId !== undefined)
      .map((receipt) => [receipt.requestId, receipt]),
  );
  const pending = new Map(items.map((item) => [Number(item.id), item]));
  return records.flatMap((record) => {
    const id = record.id ?? byRequest.get(record.requestId)?.id;
    if (id === undefined) return [];
    const receipt = byId.get(id);
    const item = pending.get(id);
    const content = item && item.mode !== "write" ? item.content : undefined;
    if (
      receipt?.entry !== undefined ||
      (content === undefined && !record.recoverable) ||
      (receipt?.status !== "queued" && receipt?.status !== "unanswered")
    )
      return [];
    return [
      {
        operationId: String(id),
        mode: record.mode,
        submittedAt: record.submittedAt,
        prompt: (
          record.prompt ?? (content === undefined ? "" : payload(content, record.images).prompt)
        ).slice(0, 2000),
        images: record.images.map(({ name, mimeType }) => ({
          ...(name ? { name } : {}),
          mimeType,
        })),
        status:
          receipt.status === "queued"
            ? "queued"
            : receipt.reason === "aborted"
              ? "cancelled"
              : "failed",
      },
    ];
  });
}

/** A queued input can be withdrawn, but a placed input can never be undone by this endpoint. */
export async function withdrawInput(
  runtime: ThreadRuntime,
  operationId: string,
): Promise<WithdrawnInput> {
  if (!/^[1-9]\d*$/.test(operationId) || !Number.isSafeInteger(Number(operationId)))
    throw new CoreError({ code: "InvalidInput", message: "消息标识无效" });
  const id = Number(operationId) as SubmissionId;
  const receipt = await runtime.storage.submission(id, BACKGROUND_CONTEXT);
  if (!receipt || receipt.conversationId !== runtime.conversation.id || receipt.type !== "input")
    throw new CoreError({ code: "NotFound", message: "消息不存在" });
  const record = (await inputRecords(runtime)).find(
    (record) => record.id === id || record.requestId === receipt.requestId,
  );
  if (!record) throw new CoreError({ code: "NotFound", message: "消息不支持撤回" });
  if (record.id === undefined) await rememberInput(runtime, { ...record, id });
  if (receipt.entry !== undefined) return { status: "already_placed" };
  const recovery = await runtime.harness.snapshot(
    RecoveryDoc,
    runtime.conversation.id,
    record.requestId,
    BACKGROUND_CONTEXT,
  );
  const result = await runtime.harness.abortSubmission(
    id,
    BACKGROUND_CONTEXT,
    runtime.conversation.id,
  );
  const latest = await runtime.storage.submission(id, BACKGROUND_CONTEXT);
  if (latest?.entry !== undefined) return { status: "already_placed" };
  return {
    status:
      result === "aborted"
        ? "withdrawn"
        : result === "already_placed"
          ? "already_placed"
          : "settled",
    ...(result !== "already_placed" && recovery?.content != null
      ? {
          ...payload(recovery.content as UserInput, recovery.images),
          prompt: recovery.prompt,
        }
      : {}),
  };
}
