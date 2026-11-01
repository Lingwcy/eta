import type { AgentSnapshot, InputMode } from "@eta/core/agent/protocol";
import type { ImageAttachment } from "@eta/core/images/types";

/** Presentation only: admission and execution remain owned by Core's durable inbox. */
export interface SubmittedInput {
  requestId: string;
  operationId?: string;
  inputEntryId?: string;
  prompt: string;
  images?: readonly ImageAttachment[];
  mode: InputMode;
  submittedAt: number;
  status: "sending" | "queued" | "uncertain";
}

export const inputMessageId = (requestId: string) => `input:${requestId}`;

export function unplacedInputs(snapshot: AgentSnapshot, inputs: readonly SubmittedInput[]) {
  const requests = new Set(
    snapshot.transcript.flatMap((entry) =>
      entry.requestId === undefined ? [] : [entry.requestId],
    ),
  );
  const entries = new Set(snapshot.transcript.map((entry) => entry.id));
  const settled = new Set(
    snapshot.queuedInputs?.flatMap((input) =>
      input.status === "queued" || input.requestId === undefined ? [] : [input.requestId],
    ),
  );
  return inputs.filter(
    (input) =>
      !requests.has(input.requestId) &&
      !settled.has(input.requestId) &&
      (!input.inputEntryId || !entries.has(input.inputEntryId)),
  );
}

export function submittedMessages(snapshot: AgentSnapshot, inputs: readonly SubmittedInput[] = []) {
  const local = unplacedInputs(snapshot, inputs);
  const byRequest = new Map(local.map((input) => [input.requestId, input]));
  const byOperation = new Map(
    local.flatMap((input) => (input.operationId ? [[input.operationId, input] as const] : [])),
  );
  const requests = new Set(
    snapshot.transcript.flatMap((entry) =>
      entry.requestId === undefined ? [] : [entry.requestId],
    ),
  );
  const shown = new Set<string>();
  const queued = (snapshot.queuedInputs ?? []).flatMap((input) => {
    if (input.requestId !== undefined && requests.has(input.requestId)) return [];
    const own =
      (input.requestId === undefined ? undefined : byRequest.get(input.requestId)) ??
      byOperation.get(input.operationId);
    const requestId = own?.requestId ?? input.requestId;
    if (requestId !== undefined) shown.add(requestId);
    return [
      {
        id: requestId === undefined ? `queued:${input.operationId}` : inputMessageId(requestId),
        message: {
          role: "user" as const,
          content: own ? content(own) : input.prompt,
          timestamp: input.submittedAt,
        },
        streaming: false,
      },
    ];
  });
  return [
    ...queued,
    ...local
      .filter((input) => !shown.has(input.requestId))
      .map((input) => ({
        id: inputMessageId(input.requestId),
        message: { role: "user" as const, content: content(input), timestamp: input.submittedAt },
        streaming: false,
      })),
  ];
}

function content(input: SubmittedInput) {
  return [
    { type: "text" as const, text: input.prompt },
    ...(input.images ?? []).map(({ data, mimeType }) => ({
      type: "image" as const,
      data,
      mimeType,
    })),
  ];
}
