import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { desktopServices } from "./service/layer.ts";
import { ModelCatalogService } from "./service/models/index.ts";
import { ProjectService } from "@eta/core/service/projects/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import { ThreadService } from "@eta/core/service/threads/index";
import { RunSupervisorService } from "@eta/core/service/runs/index";
import { ScheduleService } from "@eta/core/service/schedules/index";
import { ScheduleDispatcherService } from "@eta/core/service/schedules/dispatcher";
import { startDesktopScheduler } from "./schedules.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("Desktop main dispatches and records work without a renderer, then stops future delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-desktop-schedules-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "desktop-schedule",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const runtime = ManagedRuntime.make(
    desktopServices(join(root, "data"), ModelCatalogService.layerWith(models)),
  );
  cleanups.push(() => runtime.dispose());
  const projects = await runtime.runPromise(ProjectService);
  const project = await runtime.runPromise(projects.register({ rootPath: cwd }));
  const workspaces = await runtime.runPromise(WorkspaceService);
  const workspace = (await runtime.runPromise(workspaces.list(project.id)))[0];
  const threads = await runtime.runPromise(ThreadService);
  const schedules = await runtime.runPromise(ScheduleService);
  const thread = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.rename(thread.id, "Scheduled desktop work"));
  const stop = await startDesktopScheduler({
    threads,
    workspaces,
    dispatcher: await runtime.runPromise(ScheduleDispatcherService),
    runs: await runtime.runPromise(RunSupervisorService),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
  });
  cleanups.push(stop);
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'await tools.write({path:"background.txt",content:"Main process work"});',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Saved"),
  ]);
  const request = await runtime.runPromise(
    schedules.write({
      threadId: thread.id,
      requestId: "create",
      change: {
        action: "create",
        name: "Background",
        prompt: "Write background.txt",
        rule: { type: "once", at: Date.now() + 300 },
      },
    }),
  );
  await expect
    .poll(async () => (await runtime.runPromise(schedules.runs(request.scheduleId!)))[0]?.state, {
      timeout: 10000,
    })
    .toBe("succeeded");
  expect(await readFile(join(cwd, "background.txt"), "utf8")).toBe("Main process work");
  expect(stop()).toBe(stop());
  await stop();
  const later = await runtime.runPromise(
    schedules.write({
      threadId: thread.id,
      requestId: "later",
      change: {
        action: "create",
        name: "After stop",
        prompt: "Do not run",
        rule: { type: "once", at: Date.now() + 50 },
      },
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  expect(await runtime.runPromise(schedules.runs(later.scheduleId!))).toEqual([]);
  expect(
    (await runtime.runPromise(threads.open(thread.id))).snapshot.transcript.filter(
      (entry) => entry.message.role === "user",
    ),
  ).toHaveLength(1);
}, 15000);
