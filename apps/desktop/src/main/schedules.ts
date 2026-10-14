import type { RunSupervisorService } from "@eta/core/service/runs/index";
import type { Effect } from "effect";
import type { ThreadService } from "@eta/core/service/threads/index";
import type { WorkspaceService } from "@eta/core/service/workspaces/index";
import type { ScheduleDispatcherService } from "@eta/core/service/schedules/dispatcher";
import { scheduleHostAdapter } from "@eta/core/service/schedules/host";

/** Main owns scheduling independently of windows and renderer subscriptions. */
export async function startDesktopScheduler(options: {
  threads: ThreadService["Service"];
  workspaces: WorkspaceService["Service"];
  dispatcher: ScheduleDispatcherService["Service"];
  runs: RunSupervisorService["Service"];
  run<A, E>(this: void, effect: Effect.Effect<A, E>): Promise<A>;
}) {
  const { threads, workspaces, dispatcher, run } = options;
  const host = scheduleHostAdapter(
    {
      submit: (id, prompt, requestId) => run(threads.submit(id, prompt, requestId)),
      operationByRequest: (id, requestId) => run(threads.operationByRequest(id, requestId)),
      recovery: (id) => run(threads.recovery(id)),
    },
    async (id) => {
      const thread = await run(threads.get(id));
      if (thread.archivedAt !== undefined) return "archived";
      await run(workspaces.validate(thread.workspaceId));
      return undefined;
    },
  );
  await run(
    dispatcher.start({ ...host, subscribe: (listener) => options.runs.subscribe(listener) }),
  );
  let closing: Promise<void> | undefined;
  return () => (closing ??= run(dispatcher.stop));
}
