import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DateTime, ManagedRuntime } from "effect";
import { testServices } from "../../support/runtime.ts";
import { ProjectService } from "@eta/core/service/projects/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import { ThreadService } from "@eta/core/service/threads/index";
import { RuntimeRegistryService } from "@eta/core/service/runtime/index";
import { ScheduleService } from "@eta/core/service/schedules/index";
import { ScheduleStoreService } from "@eta/core/service/schedules/store";
import { ScheduleDispatcherService } from "@eta/core/service/schedules/dispatcher";
import { scheduleHostAdapter } from "@eta/core/service/schedules/host";
import { scheduleDraft } from "@eta/core/service/schedules/management";
import { discoverScheduleOccurrences } from "@eta/core/service/schedules/occurrences";

const [dataRoot, cwd, phase] = process.argv.slice(2);
if (!dataRoot || !cwd || !phase || !process.send)
  throw new Error("Crash fixture requires paths, phase and IPC");
const provider = fauxProvider({
  provider: "schedule-crash",
  models: [{ id: "one" }],
  tokensPerSecond: phase === "finished" ? 10000 : 1,
});
provider.setResponses([
  fauxAssistantMessage(
    phase === "finished"
      ? "Finished before receipt refresh"
      : "Deliberately unfinished scheduled work ".repeat(100),
  ),
]);
const models = createModels();
models.setProvider(provider.provider);
const runtime = ManagedRuntime.make(testServices(dataRoot, models));
const projects = await runtime.runPromise(ProjectService);
const project = await runtime.runPromise(projects.register({ rootPath: cwd }));
const workspaces = await runtime.runPromise(WorkspaceService);
const workspace = (await runtime.runPromise(workspaces.list(project.id)))[0];
const threads = await runtime.runPromise(ThreadService);
const thread = await runtime.runPromise(threads.create(workspace.id));
await runtime.runPromise(threads.rename(thread.id, "Crash schedule"));
const schedules = await runtime.runPromise(ScheduleService);
const store = await runtime.runPromise(ScheduleStoreService);
const dispatcher = await runtime.runPromise(ScheduleDispatcherService);
const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
const scheduledAt = now + 1000;
await runtime.runPromise(
  schedules.write({
    threadId: thread.id,
    requestId: "create",
    change: {
      action: "create",
      name: "Crash review",
      prompt: "One scheduled user message",
      rule: { type: "once", at: scheduledAt },
    },
  }),
);
const hold = () => new Promise<never>(() => {});
const report = () => {
  process.send?.({ threadId: thread.id, scheduledAt, phase });
};
const adapter = scheduleHostAdapter(
  {
    submit: (id, prompt, requestId) => runtime.runPromise(threads.submit(id, prompt, requestId)),
    operationByRequest: (id, requestId) =>
      runtime.runPromise(threads.operationByRequest(id, requestId)),
    recovery: (id) => runtime.runPromise(threads.recovery(id)),
  },
  async (id) => {
    const thread = await runtime.runPromise(threads.get(id));
    await runtime.runPromise(workspaces.validate(thread.workspaceId));
    return undefined;
  },
);
if (phase === "pending") {
  await runtime.runPromise(
    store.update((state) => {
      const draft = scheduleDraft(state);
      discoverScheduleOccurrences(draft, thread.id, scheduledAt);
      return draft;
    }),
  );
  report();
  await hold();
} else {
  const submit = adapter.submit.bind(adapter);
  adapter.submit = async (input) => {
    if (phase === "dispatching") {
      report();
      return hold();
    }
    const result = await submit(input);
    if (phase === "submitted") {
      report();
      return hold();
    }
    return result;
  };
  await runtime.runPromise(dispatcher.tick(adapter, scheduledAt));
  if (phase === "finished") {
    const registry = await runtime.runPromise(RuntimeRegistryService);
    const record = await runtime.runPromise(registry.acquire(thread.thread.sessionRef));
    await record.harness.waitForIdle(BACKGROUND_CONTEXT);
  }
  report();
  await hold();
}
