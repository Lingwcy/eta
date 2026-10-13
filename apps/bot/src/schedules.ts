import { CoreError, type CoreClient } from "@eta/core";
import type { ScheduleHostAdapter } from "@eta/core/service/schedules/dispatcher";
import { scheduleHostAdapter } from "@eta/core/service/schedules/host";
import { BotController } from "./controller.ts";
import { BotProjects } from "./projects.ts";
import { BotHttpError } from "./errors.ts";

/** Keep scheduling inside Bot's Controller policy, including post-admission monitor failures. */
export function botScheduleAdapter(
  core: CoreClient,
  controller: BotController,
  projects: BotProjects,
): ScheduleHostAdapter {
  const adapter = scheduleHostAdapter(
    {
      submit: (id, prompt, requestId) => controller.submit(id, prompt, requestId),
      operationByRequest: (id, requestId) => core.operationByRequest(id, requestId),
      recovery: (id) => core.recovery(id),
    },
    async (id) => {
      await projects.refresh();
      const view = await controller.authorize(id);
      if (!projects.workspaceProjects.has(view.thread.workspaceId)) return "workspaceUnavailable";
      return undefined;
    },
  );
  return {
    ...adapter,
    subscribe: (listener) => controller.subscribeCapacity(listener),
    submit: async (input) => {
      try {
        return {
          status: "admitted",
          admission: await controller.submit(input.threadId, input.prompt, input.requestId),
        };
      } catch (error) {
        // These Controller errors are raised before it invokes Core.submit.
        if (
          error instanceof BotHttpError &&
          ["Busy", "RuntimeClosing", "ProjectUnavailable"].includes(error.code)
        )
          return {
            status: "blocked",
            reason:
              error.code === "Busy"
                ? "busy"
                : error.code === "ProjectUnavailable"
                  ? "workspaceUnavailable"
                  : "runtimeClosing",
          };
        // Core may have admitted before Controller.monitor failed; consult its durable receipt.
        const found = await adapter.lookup(input);
        if (found.status === "admitted") return { status: "admitted", admission: found.operation };
        if (
          found.status === "absent" &&
          found.settled &&
          error instanceof CoreError &&
          [
            "Busy",
            "RecoveryRequired",
            "WorkspaceUnavailable",
            "ModelUnavailable",
            "SandboxUnavailable",
          ].includes(error.code)
        )
          return { status: "blocked", reason: error.code };
        return { status: "unknown", reason: "admissionUnknown" };
      }
    },
  };
}
