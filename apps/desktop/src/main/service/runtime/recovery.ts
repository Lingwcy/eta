import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@eta/agent";
import type { Harness } from "@eta/agent";
import { SubagentsDoc } from "../../../agent/extension/subagent/index.ts";
import type { createSubagentsExtension } from "../../../agent/extension/subagent/index.ts";
import { TITLE_TASK_KIND } from "../../../agent/extension/title/task.ts";

type WorkInspection = {
  submissions: readonly unknown[];
  tasks: readonly { record: { kind: string; background?: boolean } }[];
};

export function requiresRecovery(inspection: WorkInspection) {
  return (
    inspection.submissions.length > 0 ||
    inspection.tasks.some(({ record }) => record.kind !== TITLE_TASK_KIND || !record.background)
  );
}

export function hasForegroundWork(inspection: WorkInspection) {
  return (
    inspection.submissions.length > 0 ||
    inspection.tasks.some(({ record }) => record.kind !== TITLE_TASK_KIND)
  );
}

export async function recoverRuntime(
  harness: Harness,
  subagents: ReturnType<typeof createSubagentsExtension>,
) {
  // Finish a persisted stop intent after interruption before allowing any model work to resume.
  const delegated = await harness.snapshot(SubagentsDoc, BACKGROUND_CONTEXT);
  if (delegated?.stopping) await subagents.stopAll();
  else {
    for (const child of delegated?.agents.filter(
      (child) =>
        child.stopping &&
        !delegated.agents.find((parent) => parent.path === child.parent)?.stopping,
    ) ?? []) {
      await subagents.execute(
        { action: "stop", path: child.path },
        ROOT_CONVERSATION_ID,
        `recover-stop:${child.path}`,
      );
    }
  }
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  return { inspection, recoveryRequired: requiresRecovery(inspection) };
}
