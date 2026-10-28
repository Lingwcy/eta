import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from "@eta/agent";
import type { JsonObject, TaskId, Tx } from "@eta/agent";
import type { SandboxApproval } from "../../shared/sandbox.ts";

export type Approval = {
  -readonly [
    K in keyof Omit<SandboxApproval, "args" | "readableRoots" | "writableRoots">
  ]: SandboxApproval[K];
} & {
  args: JsonObject;
  taskId: TaskId;
  readableRoots: string[];
  writableRoots: string[];
  /** Internal admission identity, omitted from client approval projections. */
  rootRunId?: number;
};

/** A Git-only scope approved for the rest of the current root run; cleared when that run ends. */
export type RunGrant = {
  id: string;
  taskId: TaskId;
  conversationId: string;
  /** Optional only for legacy records, which are never reusable. */
  rootRunId?: number;
  revision: number;
  readableRoots: string[];
  writableRoots: string[];
  by: "user" | "auto";
};

export const ApprovalsDoc = defineDoc<{ requests: Approval[]; runGrants?: RunGrant[] }>({
  kind: "eta.sandbox-approvals",
  version: 1,
  scope: "session",
  initial: () => ({ requests: [] }),
  checkpointWhen: () => false,
});

/** The first submission stays stable across generation task handoffs. */
export async function activeRootRun(tx: Tx) {
  return (await tx.doc(LiveDoc, ROOT_CONVERSATION_ID)).run?.inputs[0];
}

/** Snapshot a request's scope; call inside the transaction that reads it. */
export function runGrant(request: Approval, by: RunGrant["by"]): RunGrant {
  return {
    id: request.id,
    taskId: request.taskId,
    conversationId: request.conversationId,
    rootRunId: request.rootRunId,
    revision: request.revision,
    readableRoots: [...request.readableRoots],
    writableRoots: [...request.writableRoots],
    by,
  };
}
