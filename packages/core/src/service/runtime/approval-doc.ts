import { defineDoc } from "@eta/agent";
import type { JsonObject, TaskId } from "@eta/agent";
import type { SandboxApproval } from "../../shared/sandbox.ts";

export type Approval = {
  -readonly [
    K in keyof Omit<SandboxApproval, "args" | "readableRoots" | "writableRoots">
  ]: SandboxApproval[K];
} & { args: JsonObject; taskId: TaskId; readableRoots: string[]; writableRoots: string[] };

export const ApprovalsDoc = defineDoc<{ requests: Approval[] }>({
  kind: "eta.sandbox-approvals",
  version: 1,
  scope: "session",
  initial: () => ({ requests: [] }),
});
