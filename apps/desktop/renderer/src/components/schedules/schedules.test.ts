// @vitest-environment jsdom
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement, useState, Fragment } from "react";
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
import type { DesktopLibraryController } from "@/agent/use-desktop-library";
import { ThreadActionsProvider } from "@/components/threads/thread-actions";
import { ThreadSearchDialog } from "@/components/sidebar/thread-search-dialog";
import { useSchedules } from "@/agent/use-schedules";
import { ScheduleForm } from "./schedule-form";
import { ScheduleSidebar } from "./schedule-sidebar";
import { SchedulePanel } from "./schedule-panel";

const cleanups: Array<() => Promise<void>> = [];
let root: Root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  const path = await mkdtemp(join(tmpdir(), "eta-schedule-ui-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  const cwd = join(path, "repo");
  await mkdir(cwd);
  const models = createModels();
  models.setProvider(
    fauxProvider({ provider: "schedule-ui", models: [{ id: "one" }, { id: "two" }] }).provider,
  );
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
    createThread: (id, requestId, configuration) =>
      runtime.runPromise(threads.create(id, requestId, configuration)),
    openThread: (id) => runtime.runPromise(threads.open(id)),
    configureThread: (id, provider, modelId, level) =>
      runtime.runPromise(threads.configure(id, provider, modelId, level)),
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
    openThread: (id) => application.openThread(id),
    configureThread: (id, provider, modelId, level) =>
      application.configureThread(id, provider, modelId, level),
    createThread: (workspaceId, requestId, configuration) =>
      dispatchCommand(application as unknown as DesktopApplication, {
        type: "create",
        workspaceId,
        requestId,
        configuration,
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
    | "openThread"
    | "configureThread"
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
    (button) => button.textContent?.trim() === text.trim(),
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
  await click("创建");
  await expect.poll(async () => (await runtime.runPromise(schedules.list())).length).toBe(1);
  await act(async () => {
    await Promise.resolve();
  });
  await expect.poll(() => document.body.textContent).toContain("Response lost");
  expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Review repository");
  await click("创建");
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

test("state-change proposals describe the state action and approval preserves that action", async () => {
  const { runtime, schedules, threads, workspace, library } = await setup();
  const thread = await runtime.runPromise(threads.create(workspace.id));
  library.threads = [thread.thread];
  const created = await runtime.runPromise(
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
  await runtime.runPromise(
    schedules.propose({
      threadId: thread.id,
      requestId: "pause-proposal",
      sourceIdentity: "root:tool",
      change: { action: "pause", scheduleId: created.scheduleId!, expectedRevision: 1 },
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
  await expect
    .poll(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      return document.body.textContent;
    })
    .toContain("拟变更：暂停后续执行");
  expect(button("修改")).toBeUndefined();
  await click("批准");
  await expect
    .poll(async () => (await runtime.runPromise(schedules.list()))[0].state)
    .toBe("paused");
  expect((await runtime.runPromise(schedules.list()))[0].prompt).toBe("Review repository");
});

test("adding a plan from search closes its modal and saves against the selected existing thread", async () => {
  const { runtime, schedules, threads, workspace, library } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.rename(created.id, "Searchable schedule chat"));
  library.threads = [await runtime.runPromise(threads.get(created.id))];
  const desktop = {
    library,
    busy: false,
    error: null,
    mainModel: undefined,
    selectMainModel: () => {},
    refresh: async () => library,
    reload: () => {},
    act: async (action: () => Promise<void>) => action(),
    updateSettings: async () => {},
    clearError: () => {},
  } satisfies DesktopLibraryController;
  function Search() {
    const [target, setTarget] = useState<string>();
    const controller = useSchedules();
    const children = createElement(
      Fragment,
      null,
      createElement(ThreadSearchDialog, {
        library,
        archived: false,
        busy: false,
        canCreate: true,
        runningThreadIds: new Set<string>(),
        onSelect: () => {},
        onNew: () => {},
        onChoose: () => {},
        onSkills: () => {},
      }),
      target
        ? createElement(ScheduleForm, {
            controller,
            library,
            threadId: target,
            workspaceId: workspace.id,
            onCancel: () => setTarget(undefined),
            onSaved: () => {},
          })
        : null,
    );
    return createElement(ThreadActionsProvider, {
      desktop,
      onOverlay: () => {},
      onSchedule: setTarget,
      children,
    });
  }
  await act(async () => root.render(createElement(Search)));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="搜索聊天"]')!.click(),
  );
  await expect
    .poll(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      return document.querySelector('[role="option"]')?.textContent;
    })
    .toContain("Searchable schedule chat");
  const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
    element.textContent?.includes("Searchable schedule chat"),
  )!;
  await act(async () =>
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 10, clientY: 10 }),
    ),
  );
  await expect
    .poll(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      return [...document.querySelectorAll('[role="menuitem"]')].some((element) =>
        element.textContent?.includes("添加定时任务"),
      );
    })
    .toBe(true);
  const add = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
    element.textContent?.includes("添加定时任务"),
  )!;
  await act(async () => add.click());
  await expect.poll(() => document.querySelector('input[placeholder="搜索聊天"]')).toBeNull();
  await input(
    document.querySelector<HTMLInputElement>('input:not([type="datetime-local"])')!,
    "Search plan",
  );
  await input(document.querySelector<HTMLTextAreaElement>("textarea")!, "Review selected thread");
  await click("创建");
  await expect
    .poll(async () => (await runtime.runPromise(schedules.list(created.id))).length)
    .toBe(1);
  expect(await runtime.runPromise(threads.list(undefined, true))).toHaveLength(1);
});

test("sidebar filters multiple states and creates a task through its dialog with the shared model picker", async () => {
  const { runtime, schedules, threads, workspace, library } = await setup();
  const first = await runtime.runPromise(threads.create(workspace.id));
  library.threads = [first.thread];
  const catalog = await runtime.runPromise(ModelCatalogService);
  library.models = await runtime.runPromise(catalog.list);
  const alternate = library.models.find((model) => model.id === "two")!;
  await runtime.runPromise(
    schedules.write({
      threadId: first.id,
      requestId: "active",
      change: {
        action: "create",
        name: "Upcoming review",
        prompt: "Review",
        rule: { type: "interval", everyMs: 10800000, anchorAt: Date.now() },
      },
    }),
  );
  const second = await runtime.runPromise(threads.create(workspace.id));
  library.threads = [...library.threads, second.thread];
  const paused = await runtime.runPromise(
    schedules.write({
      threadId: second.id,
      requestId: "paused",
      change: {
        action: "create",
        name: "Paused review",
        prompt: "Review",
        rule: { type: "daily", time: "09:00", timeZone: "America/New_York" },
      },
    }),
  );
  await runtime.runPromise(
    schedules.write({
      threadId: second.id,
      requestId: "pause",
      change: { action: "pause", scheduleId: paused.scheduleId!, expectedRevision: 1 },
    }),
  );
  let saved: string | undefined;
  function Sidebar() {
    const controller = useSchedules();
    return createElement(ScheduleSidebar, {
      library,
      controller,
      onSelect: () => {},
      onSaved: (id) => {
        saved = id;
      },
    });
  }
  await act(async () => root.render(createElement(Sidebar)));
  await expect.poll(() => document.body.textContent).toContain("Upcoming review");
  expect(document.body.textContent).toContain("Paused review");
  expect(document.body.textContent).toContain("每 3 小时");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="筛选任务状态"]')!.click(),
  );
  const checkbox = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].find(
      (item) => item.textContent === label,
    )!;
  await act(async () => checkbox("已开启").click());
  expect(document.querySelector("nav")?.textContent).not.toContain("Upcoming review");
  expect(document.querySelector("nav")?.textContent).toContain("Paused review");
  await act(async () => checkbox("已开启").click());
  expect(document.querySelector("nav")?.textContent).toContain("Upcoming review");
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await click(" 新建任务");
  await expect
    .poll(() => document.querySelector('[role="dialog"]')?.textContent)
    .toContain("设置定时任务");
  await input(
    document.querySelector<HTMLInputElement>('input:not([type="datetime-local"])')!,
    "Created in dialog",
  );
  await input(document.querySelector<HTMLTextAreaElement>("textarea")!, "Review through picker");
  await act(async () => button("高级")!.click());
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="选择模型与思考级别"]')!.click(),
  );
  await expect
    .poll(() => document.querySelector('[aria-label="可用模型"]')?.textContent)
    .toContain(first.model.name);
  const option = document
    .querySelector('[aria-label="可用模型"]')!
    .querySelector<HTMLButtonElement>(`button[title="${alternate.provider}/${alternate.id}"]`)!;
  await act(async () => option.click());
  await act(async () =>
    document
      .querySelector<HTMLInputElement>('[aria-label="搜索模型或服务"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("设置定时任务");
  await click("创建");
  await expect.poll(() => saved).toBeDefined();
  const session = await runtime.runPromise(threads.open(saved!));
  expect(session.snapshot.configuration.model).toEqual({
    provider: alternate.provider,
    modelId: alternate.id,
  });
  expect((await runtime.runPromise(schedules.list(saved!)))[0].prompt).toBe(
    "Review through picker",
  );
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
});
