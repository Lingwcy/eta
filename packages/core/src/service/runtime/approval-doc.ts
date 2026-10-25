import { defineDoc } from "@eta/agent";
import type { JsonObject, TaskId } from "@eta/agent";
import type { SandboxApproval } from "../../shared/sandbox.ts";

export type Approval = {
  -readonly [
    K in keyof Omit<SandboxApproval, "args" | "readableRoots" | "writableRoots">
  ]: SandboxApproval[K];
} & { args: JsonObject; taskId: TaskId; readableRoots: string[]; writableRoots: string[] };

/** A Git-only scope approved for the rest of the current root run; cleared when that run ends. */
export type RunGrant = {
  id: string;
  taskId: TaskId;
  conversationId: string;
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

/** Snapshot a request's scope; call inside the transaction that reads it. */
export function runGrant(request: Approval, by: RunGrant["by"]): RunGrant {
  return {
    id: request.id,
    taskId: request.taskId,
    conversationId: request.conversationId,
    revision: request.revision,
    readableRoots: [...request.readableRoots],
    writableRoots: [...request.writableRoots],
    by,
  };
}
