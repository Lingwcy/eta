import type { OperationAdmission, OperationResult, RecoveryState } from "../../agent/protocol.ts";
import { CoreError } from "../errors.ts";
import type { ScheduleHostAdapter } from "./dispatcher.ts";

export interface ScheduleSubmissionHost {
  submit(threadId: string, prompt: string, requestId: string): Promise<OperationAdmission>;
  operationByRequest(threadId: string, requestId: string): Promise<OperationResult | undefined>;
  recovery(threadId: string): Promise<RecoveryState>;
}

/** Bot supplies Controller.submit here; a bare Core submit would bypass its admission policy. */
export function scheduleHostAdapter(
  host: ScheduleSubmissionHost,
  validate: ScheduleHostAdapter["validate"],
): ScheduleHostAdapter {
  return {
    validate,
    submit: async ({ threadId, prompt, requestId }) => {
      try {
        return { status: "admitted", admission: await host.submit(threadId, prompt, requestId) };
      } catch (error) {
        if (
          error instanceof CoreError &&
          [
            "Busy",
            "RecoveryRequired",
            "WorkspaceUnavailable",
            "ModelUnavailable",
            "RuntimeClosing",
            "InvalidInput",
            "NotFound",
          ].includes(error.code)
        )
          return { status: "blocked", reason: error.code };
        return { status: "unknown", reason: "admissionUnknown" };
      }
    },
    lookup: async ({ threadId, requestId }) => {
      try {
        const operation = await host.operationByRequest(threadId, requestId);
        if (!operation) return { status: "absent", settled: true };
        if (["completed", "failed", "aborted"].includes(operation.status))
          return { status: "admitted", operation };
        const recovery = await host.recovery(threadId);
        const reason = recovery.required
          ? "recoveryRequired"
          : recovery.blockedTasks.length > 0
            ? recovery.blockedTasks[0].reason
            : undefined;
        return { status: "admitted", operation, ...(reason ? { reason } : {}) };
      } catch (error) {
        if (error instanceof CoreError && error.code === "NotFound")
          return { status: "absent", settled: true };
        return { status: "unknown", reason: "admissionUnknown" };
      }
    },
  };
}
