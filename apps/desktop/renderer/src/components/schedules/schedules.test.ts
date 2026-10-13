// @vitest-environment jsdom
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { ManagedRuntime } from "effect";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ProjectService } from "@eta/core/service/projects/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import { ThreadService } from "@eta/core/service/threads/index";
import { ScheduleStoreService } from "@eta/core/service/schedules/store";
import { scheduleDraft, settleScheduleRequests } from "@eta/core/service/schedules/management";
import { CatalogService } from "@eta/core/service/catalog/index";
import { ScheduleService } from "@eta/core/service/schedules/index";
import { desktopServices } from "../../../../src/main/service/layer.ts";
import { ModelCatalogService } from "../../../../src/main/service/models/index.ts";
import { dispatchCommand } from "../../../../src/main/ipc.ts";
import type { DesktopApplication } from "../../../../src/main/bootstrap.ts";
import type { DesktopBridge, DesktopLibrary } from "../../../../src/bridge.ts";
import { useSchedules } from "@/agent/use-schedules";
import { ScheduleForm } from "./schedule-form";
import { SchedulePanel } from "./schedule-panel";

const cleanups: Array<() => Promise<void>> = [];
let root: Root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const path = await mkdtemp(join(tmpdir(), "eta-schedule-ui-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  const cwd = join(path, "repo");
  await mkdir(cwd);
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "schedule-ui", models: [{ id: "one" }] }).provider);
  const runtime = ManagedRuntime.make(
    desktopServices(join(path, "data"), ModelCatalogService.layerWith(models)),
  );
  cleanups.push(() => runtime.dispose());
  const projects = await runtime.runPromise(ProjectService);
  const project = await runtime.runPromise(projects.register({ rootPath: cwd }));
  const workspaces = await runtime.runPromise(WorkspaceService);
  const workspace = (await runtime.runPromise(workspaces.list(project.id)))[0];
  const threads = await runtime.runPromise(ThreadService);
  const schedules = await runtime.runPromise(ScheduleService);
  const library: DesktopLibrary = {
    projects: [project],
    workspaces: [workspace],
    threads: [],
    models: [],
    credentials: [],
    providers: [],
    settings: { defaultThinkingLevel: "off" },
  };
  const application = {
    scheduleSnapshot: async () => ({
      snapshots: [
        {
          environment: { id: "local", label: "本地", status: "connected" },
          data: await runtime.runPromise(schedules.snapshot),
        },
      ],
    }),
    createThread: (id, requestId) => runtime.runPromise(threads.create(id, requestId)),
    renameThread: (id, title) => runtime.runPromise(threads.rename(id, title)),
    writeSchedule: (input) => runtime.runPromise(schedules.write(input)),
    proposeSchedule: (input) => runtime.runPromise(schedules.propose(input)),
    decideSchedule: (input, approved) => runtime.runPromise(schedules.decide(input, approved)),
    runSchedule: (input) => runtime.runPromise(schedules.runNow(input)),
    scheduleRuns: (id) => runtime.runPromise(schedules.runs(id)),
    scheduleRequest: (_threadId, requestId) => runtime.runPromise(schedules.request(requestId)),
  } satisfies Partial<DesktopApplication>;
  const bridge = {
    scheduleSnapshot: () =>
      dispatchCommand(application as unknown as DesktopApplication, { type: "schedule-snapshot" }),
    scheduleRequest: (threadId, requestId) =>
      dispatchCommand(application as unknown as DesktopApplication, {
        type: "schedule-request",
        threadId,
        requestId,
      }),
    subscribeSchedules: (listener) => schedules.subscribe(listener),
    createThread: (workspaceId, requestId) =>
      dispatchCommand(application as unknown as DesktopApplication, {
        type: "create",
        workspaceId,
        requestId,
      }),
    renameThread: (id, title) =>
      dispatchCommand(application as unknown as DesktopApplication, { type: "rename", id, title }),
    writeSchedule: (input) =>
      dispatchCommand(application as unknown as DesktopApplication, {
        type: "schedule-write",
        input,
      }),
    proposeSchedule: (input) =>
      dispatchCommand(application as unknown as DesktopApplication, {
        type: "schedule-propose",
        input,
      }),
    decideSchedule: (input, approved) =>
      dispatchCommand(application as unknown as DesktopApplication, {
        type: "schedule-decide",
        input,
        approved,
      }),
    runSchedule: (input) =>
      dispatchCommand(application as unknown as DesktopApplication, {
        type: "schedule-run",
        input,
      }),
  } as Pick<
    DesktopBridge,
    | "scheduleSnapshot"
    | "subscribeSchedules"
    | "createThread"
    | "renameThread"
    | "writeSchedule"
    | "proposeSchedule"
    | "decideSchedule"
    | "scheduleRequest"
    | "runSchedule"
  >;
  vi.stubGlobal("eta", bridge);
  Object.defineProperty(window, "eta", { configurable: true, value: bridge });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  return { runtime, schedules, threads, workspace, library, bridge };
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  )!;
}
async function click(text: string) {
  await expect
    .poll(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      return button(text)?.disabled;
    })
    .toBe(false);
  await act(async () => button(text).click());
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("creation retains its draft and reuses the same thread and request after the successful response is lost", async () => {
  const { runtime, schedules, threads, library, bridge } = await setup();
  let lose = true;
  const requests: string[] = [];
  const queries: string[] = [];
  const query = bridge.scheduleRequest;
  bridge.scheduleRequest = async (threadId, requestId) => {
    queries.push(requestId);
    if (queries.length === 1) throw new Error("Receipt endpoint unavailable");
    return query(threadId, requestId);
  };
  const write = bridge.writeSchedule;
  bridge.writeSchedule = async (request) => {
    requests.push(request.requestId);
    const result = await write(request);
    if (lose) {
      lose = false;
      throw new Error("Response lost");
    }
    return result;
  };
  const saved: string[] = [];
  function Form() {
    const controller = useSchedules();
    return createElement(ScheduleForm, {
      library,
      controller,
      onCancel: () => {},
      onSaved: (id) => saved.push(id),
    });
  }
  await act(async () => root.render(createElement(Form)));
  await input(
    document.querySelector<HTMLInputElement>('input:not([type="datetime-local"])')!,
    "Review",
  );
  await input(document.querySelector<HTMLTextAreaElement>("textarea")!, "Review repository");
  await click("保存");
  await expect.poll(async () => (await runtime.runPromise(schedules.list())).length).toBe(1);
  await act(async () => {
    await Promise.resolve();
  });
  await expect.poll(() => document.body.textContent).toContain("Response lost");
  expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Review repository");
  await click("保存");
  await expect.poll(() => saved.length).toBe(1);
  expect(requests).toHaveLength(1);
  expect(queries).toEqual([requests[0], requests[0]]);
  expect(await runtime.runPromise(threads.list(undefined, true))).toHaveLength(1);
  expect(await runtime.runPromise(schedules.list())).toHaveLength(1);
  expect((await runtime.runPromise(schedules.list()))[0].threadId).toBe(saved[0]);
});

test("inspector approves the exact proposal then supports pause, resume, manual execution and deletion through IPC", async () => {
  const { runtime, schedules, threads, workspace, library } = await setup();
  const thread = await runtime.runPromise(threads.create(workspace.id));
  library.threads = [thread.thread];
  await runtime.runPromise(
    schedules.propose({
      threadId: thread.id,
      requestId: "proposal",
      sourceIdentity: "root:tool",
      change: {
        action: "create",
        name: "Review",
        prompt: "Review repository",
        rule: { type: "interval", everyMs: 300000, anchorAt: 0 },
      },
    }),
  );
  function Panel() {
    const controller = useSchedules();
    return createElement(SchedulePanel, {
      controller,
      library,
      threadId: thread.id,
      creating: false,
      onCreate: () => {},
      onDone: () => {},
    });
  }
  await act(async () => root.render(createElement(Panel)));
  expect(await runtime.runPromise(schedules.list())).toEqual([]);
  await click("批准");
  await expect
    .poll(async () => (await runtime.runPromise(schedules.list()))[0]?.state)
    .toBe("active");
  await act(async () => {
    await Promise.resolve();
  });
  await click("暂停");
  await expect
    .poll(async () => (await runtime.runPromise(schedules.list()))[0]?.state)
    .toBe("paused");
  await act(async () => {
    await Promise.resolve();
  });
  await click("恢复");
  await expect
    .poll(async () => (await runtime.runPromise(schedules.list()))[0]?.state)
    .toBe("active");
  await act(async () => {
    await Promise.resolve();
  });
  await click("运行一次");
  const plan = (await runtime.runPromise(schedules.list()))[0];
  await expect.poll(async () => (await runtime.runPromise(schedules.runs(plan.id))).length).toBe(1);
  await act(async () => {
    await Promise.resolve();
  });
  await click("删除");
  await expect.poll(async () => (await runtime.runPromise(schedules.list())).length).toBe(0);
  expect((await runtime.runPromise(threads.get(thread.id))).id).toBe(thread.id);
});

test("editing pending proposal content invalidates its old approval without activating either plan", async () => {
  const { runtime, schedules, threads, workspace, library } = await setup();
  const thread = await runtime.runPromise(threads.create(workspace.id));
  library.threads = [thread.thread];
  await runtime.runPromise(
    schedules.propose({
      threadId: thread.id,
      requestId: "old",
      sourceIdentity: "root:tool",
      change: {
        action: "create",
        name: "Review",
        prompt: "Original review",
        rule: { type: "daily", time: "09:00", timeZone: "America/New_York" },
      },
    }),
  );
  const proposal = (await runtime.runPromise(schedules.proposals()))[0];
  function Form() {
    const controller = useSchedules();
    return createElement(ScheduleForm, {
      controller,
      library,
      threadId: thread.id,
      workspaceId: workspace.id,
      proposal,
      onCancel: () => {},
      onSaved: () => {},
    });
  }
  await act(async () => root.render(createElement(Form)));
  await input(document.querySelector<HTMLTextAreaElement>("textarea")!, "New review content");
  await click("提出新提案");
  await expect.poll(async () => (await runtime.runPromise(schedules.proposals())).length).toBe(2);
  const proposals = await runtime.runPromise(schedules.proposals());
  expect(proposals.find((value) => value.id === proposal.id)?.state).toBe("invalidated");
  expect(proposals.find((value) => value.id !== proposal.id)?.change).toMatchObject({
    prompt: "New review content",
    rule: { timeZone: "America/New_York" },
  });
  expect(await runtime.runPromise(schedules.list())).toEqual([]);
  let rejected = false;
  await act(async () => {
    rejected =
      (
        await runtime.runPromise(
          schedules.decide(
            {
              proposalId: proposal.id,
              contentFingerprint: proposal.contentFingerprint,
              requestId: "late-approve",
            },
            true,
          ),
        )
      ).state === "rejected";
  });
  expect(rejected).toBe(true);
});

test("a pending pause displays the effective active state until uncertain admission is reconciled", async () => {
  const { runtime, schedules, threads, workspace, library } = await setup();
  const thread = await runtime.runPromise(threads.create(workspace.id));
  library.threads = [thread.thread];
  const receipt = await runtime.runPromise(
    schedules.write({
      threadId: thread.id,
      requestId: "create",
      change: {
        action: "create",
        name: "Review",
        prompt: "Review repository",
        rule: { type: "interval", everyMs: 300000, anchorAt: 0 },
      },
    }),
  );
  const plan = (await runtime.runPromise(schedules.list()))[0];
  const store = await runtime.runPromise(ScheduleStoreService);
  await runtime.runPromise(
    store.update((state) => ({
      ...state,
      occurrences: {
        ...state.occurrences,
        uncertain: {
          id: "uncertain",
          scheduleId: receipt.scheduleId!,
          threadId: thread.id,
          scheduleRevision: 1,
          scheduledAt: 300000,
          detectedAt: 300000,
          source: "automatic",
          name: plan.name,
          prompt: plan.prompt,
          rule: plan.rule,
          requestId: "delivery",
          state: "dispatching",
        },
      },
    })),
  );
  function Panel() {
    const controller = useSchedules();
    return createElement(SchedulePanel, {
      controller,
      library,
      threadId: thread.id,
      creating: false,
      onCreate: () => {},
      onDone: () => {},
    });
  }
  await act(async () => root.render(createElement(Panel)));
  await click("暂停");
  await expect.poll(() => document.body.textContent).toContain("正在处理");
  expect((await runtime.runPromise(schedules.list()))[0].state).toBe("active");
  expect(document.body.textContent).toContain("Review · 已启用");
  const catalog = await runtime.runPromise(CatalogService);
  const stateCatalog = await runtime.runPromise(catalog.read);
  await act(async () =>
    runtime.runPromise(
      store.update((state) => {
        const draft = scheduleDraft(state);
        draft.occurrences.uncertain = { ...draft.occurrences.uncertain, state: "pending" };
        settleScheduleRequests(draft, thread.id, stateCatalog, Date.now());
        return draft;
      }),
    ),
  );
  await expect.poll(() => document.body.textContent).toContain("Review · 已暂停");
  expect(document.body.textContent).not.toContain("正在处理：");
});
