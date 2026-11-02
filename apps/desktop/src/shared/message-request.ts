import type { ImageAttachment } from "@eta/core/images/types";
import { DesktopCommandError, unwrapReply } from "../command-reply.ts";
import type { AgentBridge, CommandReply } from "../bridge.ts";
import type { InputMode, OperationAdmission } from "@eta/core/agent/protocol";

/** Decode in the calling realm; a rejected preload Error loses custom fields at contextBridge. */
export async function submitMessage(
  bridge: Pick<AgentBridge, "submit" | "submitReply">,
  ...args: Parameters<AgentBridge["submit"]>
) {
  if (!bridge.submitReply) return bridge.submit(...args);
  let reply: CommandReply<OperationAdmission>;
  try {
    reply = await bridge.submitReply(...args);
  } catch (error) {
    // A missing reply cannot prove rejection: main may already have admitted the write.
    // Preserve the identity for explicit retry, but do not automatically replay the operation.
    throw new DesktopCommandError({
      code: "SubmissionUnknown",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  }
  // A received failure DTO is authoritative; do not reclassify a definite rejection as unknown.
  return unwrapReply(reply);
}

/** A send whose transport outcome is unknown; the same logical message must keep its identity. */
export interface UncertainSubmission {
  requestId: string;
  prompt: string;
  whenBusy?: InputMode;
  images?: readonly ImageAttachment[];
}

function sameImages(left?: readonly ImageAttachment[], right?: readonly ImageAttachment[]) {
  if (left === right) return true;
  if (!left?.length || !right?.length) return !left?.length && !right?.length;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Reuse the durable identity only for the same payload; anything else is a new request. */
export function submissionIdentity(
  previous: UncertainSubmission | undefined,
  prompt: string,
  images?: readonly ImageAttachment[],
  whenBusy: InputMode = "reject",
) {
  return previous &&
    (previous.whenBusy ?? "reject") === whenBusy &&
    previous.prompt === prompt &&
    sameImages(previous.images, images)
    ? previous.requestId
    : crypto.randomUUID();
}

/** Retryable transport failures cannot say whether the server admitted the message. */
export function admissionUncertain(error: unknown) {
  return error instanceof DesktopCommandError && error.retryable;
}
