import type { ImageAttachment } from "@eta/core/images/types";
import { DesktopCommandError, unwrapReply } from "../command-reply.ts";
import type { AgentBridge } from "../bridge.ts";

/** Decode in the calling realm; a rejected preload Error loses custom fields at contextBridge. */
export async function submitMessage(
  bridge: Pick<AgentBridge, "submit" | "submitReply">,
  ...args: Parameters<AgentBridge["submit"]>
) {
  return bridge.submitReply
    ? unwrapReply(await bridge.submitReply(...args))
    : bridge.submit(...args);
}

/** A send whose transport outcome is unknown; the same logical message must keep its identity. */
export interface UncertainSubmission {
  requestId: string;
  prompt: string;
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
) {
  return previous && previous.prompt === prompt && sameImages(previous.images, images)
    ? previous.requestId
    : crypto.randomUUID();
}

/** Retryable transport failures cannot say whether the server admitted the message. */
export function admissionUncertain(error: unknown) {
  return error instanceof DesktopCommandError && error.retryable;
}
