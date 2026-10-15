// @vitest-environment jsdom
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement, useState, useSyncExternalStore, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { ManagedRuntime } from "effect";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { SessionResponse } from "@eta/core/agent/protocol";
import { ProjectService } from "@eta/core/service/projects/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import { ThreadService } from "@eta/core/service/threads/index";
import { ScheduleService } from "@eta/core/service/schedules/index";
import { desktopServices } from "../../../../src/main/service/layer.ts";
import { ModelCatalogService } from "../../../../src/main/service/models/index.ts";
import { dispatchCommand } from "../../../../src/main/ipc.ts";
import {
  mapScheduleSnapshot,
  mapScheduleRequest,
} from "../../../../src/main/schedule-identities.ts";
import type { DesktopApplication } from "../../../../src/main/bootstrap.ts";
import type { DesktopBridge, DesktopLibrary } from "../../../../src/bridge.ts";
import type { DesktopLibraryController } from "@/agent/use-desktop-library";
import { ThreadActionsProvider } from "@/components/threads/thread-actions";
import { ThreadSearchDialog } from "@/components/sidebar/thread-search-dialog";
import { useSchedules } from "@/agent/use-schedules";
import { ScheduleForm } from "./schedule-form";
import { TaskList } from "@/components/task-list";
import { ScheduleMessages } from "./schedule-tool-notice";
import { ThreadRecents } from "@/agent/thread-recents";
import { DesktopTabs } from "@/agent/desktop-tabs";
import { ThreadActivity } from "@/agent/thread-activity";
import { useDesktopController } from "@/agent/use-desktop-controller";
import { DesktopSidebar } from "@/components/desktop-sidebar";
import { ScheduleSidebar } from "./schedule-sidebar";
import { ToastProvider } from "@/components/ui/toast";

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
  const provider = fauxProvider({
    provider: "schedule-ui",
    models: [{ id: "one" }, { id: "two" }],
  });
  models.setProvider(provider.provider);
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
    configureSandbox: (id, mode) => runtime.runPromise(threads.configureSandbox(id, mode)),
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
    configureSandbox: (id, mode) =>
      dispatchCommand(application as unknown as DesktopApplication, {
        type: "configure-sandbox",
        id,
        mode,
      }),
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
    | "configureSandbox"
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
  return { runtime, schedules, threads, workspace, library, bridge, provider };
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
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Form))));
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
  expect((await runtime.runPromise(threads.open(saved[0]))).snapshot.sandbox?.mode).toBe(
    "danger-full-access",
  );
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
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Search))));
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
  const projects = await runtime.runPromise(ProjectService);
  const otherRoot = join(workspace.cwd, "..", "other-project");
  await mkdir(otherRoot);
  const otherProject = await runtime.runPromise(
    projects.register({ rootPath: otherRoot, name: "Other project" }),
  );
  const workspaces = await runtime.runPromise(WorkspaceService);
  const otherWorkspace = (await runtime.runPromise(workspaces.list(otherProject.id)))[0];
  library.projects = [...library.projects, otherProject];
  library.workspaces = [...library.workspaces, otherWorkspace];
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
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Sidebar))));
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
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="选择执行日期和时间"]')!.click(),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="下个月"]')!.click(),
  );
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
  const chosenDate = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-15`;
  await act(async () =>
    document.querySelector<HTMLButtonElement>(`[aria-label="${chosenDate}"]`)!.click(),
  );
  await input(document.querySelector<HTMLInputElement>('[aria-label="执行时刻"]')!, "14:30");
  await click("确定");

  await act(async () => button("高级")!.click());
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="执行工作区"]')!.click(),
  );
  const workspaceOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === "Other project",
  )!;
  await act(async () => workspaceOption.click());
  await click("高级");
  await click("高级");
  expect(document.querySelector('[aria-label="执行工作区"]')?.textContent).toContain(
    "Other project",
  );

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
  expect((await runtime.runPromise(threads.get(saved!))).workspaceId).toBe(otherWorkspace.id);
  const session = await runtime.runPromise(threads.open(saved!));
  expect(session.snapshot.configuration.model).toEqual({
    provider: alternate.provider,
    modelId: alternate.id,
  });
  expect((await runtime.runPromise(schedules.list(saved!)))[0].prompt).toBe(
    "Review through picker",
  );
  expect((await runtime.runPromise(schedules.list(saved!)))[0].rule).toEqual({
    type: "once",
    at: new Date(`${chosenDate}T14:30`).getTime(),
  });
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
});

test("weekly creation toggles weekdays and persists the machine timezone without a timezone field", async () => {
  const { runtime, schedules, library } = await setup();
  let saved: string | undefined;
  function Form() {
    const controller = useSchedules();
    return createElement(ScheduleForm, {
      library,
      controller,
      onCancel: () => {},
      onSaved: (id) => {
        saved = id;
      },
    });
  }
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Form))));
  await input(document.querySelector<HTMLInputElement>("input")!, "Weekly review");
  await input(document.querySelector<HTMLTextAreaElement>("textarea")!, "Review repository");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="重复"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent === "每周")!
      .click(),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="选择执行时间"]')!.click(),
  );
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="08时"]')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="30分"]')!.click());
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="确认执行时间"]')!.click(),
  );
  for (const label of ["星期一", "星期三", "星期五"])
    await act(async () =>
      document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(),
    );
  await click("创建");
  await expect.poll(() => saved).toBeDefined();
  expect((await runtime.runPromise(schedules.list(saved!)))[0].rule).toEqual({
    type: "weekly",
    weekdays: [3, 5],
    time: "08:30",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

test.each(["daily", "weekly"] as const)(
  "editing a %s plan preserves its timezone through real IPC",
  async (type) => {
    const { runtime, schedules, threads, workspace, library } = await setup();
    const thread = await runtime.runPromise(threads.create(workspace.id));
    const timeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Shanghai"
        ? "America/New_York"
        : "Asia/Shanghai";
    const rule =
      type === "weekly"
        ? { type, time: "09:00", timeZone, weekdays: [1, 3, 5] }
        : { type, time: "09:00", timeZone };
    await runtime.runPromise(
      schedules.write({
        threadId: thread.id,
        requestId: `timezone-${type}`,
        change: { action: "create", name: "Original", prompt: "Review repository", rule },
      }),
    );
    const original = (await runtime.runPromise(schedules.list(thread.id)))[0];
    const saved: string[] = [];
    function Form() {
      const controller = useSchedules();
      return createElement(ScheduleForm, {
        library,
        controller,
        threadId: thread.id,
        workspaceId: workspace.id,
        schedule: original,
        onCancel: () => {},
        onSaved: (id) => saved.push(id),
      });
    }
    await act(async () => root.render(createElement(Form)));
    await input(document.querySelector<HTMLInputElement>("input")!, "Renamed");
    await click("保存");
    await expect.poll(() => saved).toEqual([thread.id]);
    const updated = (await runtime.runPromise(schedules.list(thread.id)))[0];
    expect(updated.name).toBe("Renamed");
    expect(updated.rule).toEqual(original.rule);
    expect(updated.nextRunAt).toBe(original.nextRunAt);
    expect(updated.revision).toBe(original.revision + 1);
  },
);

test.each(["metadata only", "new time"] as const)(
  "editing a once plan preserves its exact instant unless rescheduled: %s",
  async (edit) => {
    const { runtime, schedules, threads, workspace, library } = await setup();
    const thread = await runtime.runPromise(threads.create(workspace.id));
    const date = new Date(Date.now() + 86400_000);
    date.setHours(9, 15, 42, 987);
    const at = date.getTime();
    await runtime.runPromise(
      schedules.write({
        threadId: thread.id,
        requestId: "precise-once",
        change: {
          action: "create",
          name: "Precise reminder",
          prompt: "Review repository",
          rule: { type: "once", at },
        },
      }),
    );
    const original = (await runtime.runPromise(schedules.list(thread.id)))[0];
    const saved: string[] = [];
    function Form() {
      const controller = useSchedules();
      return createElement(ScheduleForm, {
        library,
        controller,
        threadId: thread.id,
        workspaceId: workspace.id,
        schedule: original,
        onCancel: () => {},
        onSaved: (id) => saved.push(id),
      });
    }
    await act(async () => root.render(createElement(Form)));
    await input(document.querySelector<HTMLInputElement>("input")!, "Renamed reminder");
    if (edit === "new time") {
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label="选择执行日期和时间"]')!.click(),
      );
      await input(document.querySelector<HTMLInputElement>('[aria-label="执行时刻"]')!, "14:30");
      await click("确定");
      date.setHours(14, 30, 0, 0);
    }
    await click("保存");
    await expect.poll(() => saved).toEqual([thread.id]);
    const updated = (await runtime.runPromise(schedules.list(thread.id)))[0];
    expect(updated.name).toBe("Renamed reminder");
    expect(updated.rule).toEqual({ type: "once", at: date.getTime() });
    expect(updated.nextRunAt).toBe(date.getTime());
    expect(updated.revision).toBe(original.revision + 1);
  },
);

test("sidebar task menu supports pause, resume, run, edit and delete through real IPC", async () => {
  const { runtime, schedules, threads, workspace, library } = await setup();
  const thread = await runtime.runPromise(threads.create(workspace.id));
  library.threads = [thread.thread];
  await runtime.runPromise(
    schedules.write({
      threadId: thread.id,
      requestId: "menu-plan",
      change: {
        action: "create",
        name: "Menu review",
        prompt: "Review repository",
        rule: { type: "interval", everyMs: 10800000, anchorAt: Date.now() },
      },
    }),
  );
  function Sidebar() {
    const controller = useSchedules();
    return createElement(ScheduleSidebar, {
      library,
      controller,
      onSelect: () => {},
      onSaved: () => {},
    });
  }
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Sidebar))));
  const openMenu = async () => {
    await expect
      .poll(async () => {
        await act(async () => {
          await Promise.resolve();
        });
        return document.querySelector<HTMLButtonElement>('[aria-label$="的任务操作"]');
      })
      .not.toBeNull();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label$="的任务操作"]')!.click(),
    );
  };
  const select = async (label: string) => {
    await expect
      .poll(() =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some(
          (item) => item.textContent === label && item.getAttribute("aria-disabled") !== "true",
        ),
      )
      .toBe(true);
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === label)!
        .click(),
    );
  };
  await openMenu();
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("分享");
  await select("暂停");
  await expect
    .poll(async () => (await runtime.runPromise(schedules.list()))[0]?.state)
    .toBe("paused");
  await openMenu();
  await select("恢复");
  await expect
    .poll(async () => (await runtime.runPromise(schedules.list()))[0]?.state)
    .toBe("active");
  await openMenu();
  await select("立即运行");
  const plan = (await runtime.runPromise(schedules.list()))[0];
  await expect.poll(async () => (await runtime.runPromise(schedules.runs(plan.id))).length).toBe(1);
  await openMenu();
  await select("编辑");
  await expect
    .poll(() => document.querySelector('[role="dialog"]')?.textContent)
    .toContain("编辑定时任务");
  await input(document.querySelector<HTMLInputElement>("input")!, "Renamed review");
  await click("保存");
  await expect
    .poll(async () => (await runtime.runPromise(schedules.list()))[0]?.name)
    .toBe("Renamed review");
  expect((await runtime.runPromise(threads.open(thread.id))).snapshot.sandbox?.mode).toBe(
    "workspace-write",
  );
  await openMenu();
  await select("删除");
  await expect.poll(async () => (await runtime.runPromise(schedules.list())).length).toBe(0);
  expect((await runtime.runPromise(threads.get(thread.id))).id).toBe(thread.id);
});

test("a grouped task menu targets the selected plan without pausing its sibling", async () => {
  const { runtime, schedules, threads, workspace, library } = await setup();
  const thread = await runtime.runPromise(threads.create(workspace.id));
  library.threads = [thread.thread];
  for (const name of ["First plan", "Second plan"])
    await runtime.runPromise(
      schedules.write({
        threadId: thread.id,
        requestId: name,
        change: {
          action: "create",
          name,
          prompt: "Review repository",
          rule: { type: "interval", everyMs: 10800000, anchorAt: Date.now() },
        },
      }),
    );
  function Sidebar() {
    const controller = useSchedules();
    return createElement(ScheduleSidebar, {
      library,
      controller,
      onSelect: () => {},
      onSaved: () => {},
    });
  }
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Sidebar))));
  await expect
    .poll(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      return document.querySelector('[aria-label$="的任务操作"]');
    })
    .not.toBeNull();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label$="的任务操作"]')!.click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Second plan")!
      .click(),
  );
  await expect
    .poll(() =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some(
        (item) => item.textContent === "暂停",
      ),
    )
    .toBe(true);
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "暂停")!
      .click(),
  );
  await expect
    .poll(
      async () =>
        (await runtime.runPromise(schedules.list())).find((plan) => plan.name === "Second plan")
          ?.state,
    )
    .toBe("paused");
  expect(
    (await runtime.runPromise(schedules.list())).find((plan) => plan.name === "First plan")?.state,
  ).toBe("active");
});

test.each(["local", "bot"])(
  "the %s streamed schedule notice resolves its durable receipt and cancels the actual plan through IPC",
  async (environment) => {
    const { runtime, schedules, threads, workspace, bridge, library } = await setup();
    const thread = await runtime.runPromise(threads.create(workspace.id));
    const prefix = environment === "bot" ? "bot:fixture:" : "";
    const currentThreadId = prefix + thread.id;
    if (prefix) {
      const snapshot = bridge.scheduleSnapshot;
      bridge.scheduleSnapshot = async () => ({
        snapshots: (await snapshot()).snapshots.map((entity) => ({
          environment: { id: prefix, label: "Bot", status: "connected" },
          data: mapScheduleSnapshot(entity.data, (id) => prefix + id),
        })),
      });
      const query = bridge.scheduleRequest;
      bridge.scheduleRequest = async (_threadId, requestId) => {
        const result = await query(thread.id, requestId);
        return result ? mapScheduleRequest(result, (id) => prefix + id) : undefined;
      };
      const write = bridge.writeSchedule;
      bridge.writeSchedule = (input) =>
        write({
          ...input,
          threadId: thread.id,
          change:
            input.change.action === "create"
              ? input.change
              : { ...input.change, scheduleId: input.change.scheduleId.slice(prefix.length) },
        });
    }
    const rule = { type: "interval" as const, everyMs: 300000, anchorAt: Date.now() + 3600000 };
    const receipt = await runtime.runPromise(
      schedules.write({
        threadId: thread.id,
        requestId: "schedule:tool:stream",
        change: { action: "create", name: "Streamed reminder", prompt: "Review repository", rule },
      }),
    );
    expect(await runtime.runPromise(schedules.proposals())).toEqual([]);
    const tools = [
      {
        status: "settled" as const,
        toolCallId: "create-plan",
        toolName: "schedule",
        args: { action: "create" },
        result: {
          content: [],
          details: {
            kind: "schedule",
            threadId: thread.id,
            requestId: receipt.requestId,
            scheduleId: receipt.scheduleId,
            action: "create",
            status: "applied",
            name: "Streamed reminder",
            rule,
            nextRunAt: receipt.nextRunAt ?? null,
          },
        },
      },
    ];
    function Stream() {
      const controller = useSchedules();
      return createElement(ScheduleMessages, {
        value: { threadId: currentThreadId, controller },
        children: createElement(
          Fragment,
          null,
          createElement(TaskList, { tools }),
          createElement(ScheduleSidebar, {
            library,
            controller,
            onSelect: () => {},
            onSaved: () => {},
          }),
        ),
      });
    }
    await act(async () => root.render(createElement(ToastProvider, null, createElement(Stream))));
    await expect
      .poll(() =>
        document.querySelector(
          `[aria-label="${environment === "local" ? "本地任务" : "Bot 任务"}"]`,
        ),
      )
      .not.toBeNull();
    await click("取消计划");
    await expect.poll(async () => (await runtime.runPromise(schedules.list())).length).toBe(0);
    await expect.poll(() => document.body.textContent).toContain("计划已取消");
    await expect
      .poll(() => document.querySelector('[aria-label="本地任务"], [aria-label="Bot 任务"]'))
      .toBeNull();
    expect(await runtime.runPromise(threads.list(undefined, true))).toHaveLength(1);
  },
);

test.each(["danger-full-access", "workspace-write"] as const)(
  "scheduled task creation persists %s permissions",
  async (mode) => {
    const { runtime, schedules, threads, library } = await setup();
    let saved: string | undefined;
    function Form() {
      const controller = useSchedules();
      return createElement(ScheduleForm, {
        library,
        controller,
        onCancel: () => {},
        onSaved: (id) => {
          saved = id;
        },
      });
    }
    await act(async () => root.render(createElement(ToastProvider, null, createElement(Form))));
    await input(document.querySelector<HTMLInputElement>("input")!, "Permission test");
    await input(document.querySelector<HTMLTextAreaElement>("textarea")!, "Review repository");
    await click("高级");
    if (mode === "workspace-write") {
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label="沙盒策略：完全访问"]')!.click(),
      );
      const picker = document.querySelector('[aria-label="沙盒策略"]')!;
      await act(async () =>
        [...picker.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.startsWith("工作区沙盒"))!
          .click(),
      );
    }
    await click("创建");
    await expect.poll(() => saved).toBeDefined();
    expect((await runtime.runPromise(threads.open(saved!))).snapshot.sandbox?.mode).toBe(mode);
    expect((await runtime.runPromise(schedules.list(saved!)))[0].name).toBe("Permission test");
  },
);

test("project thread markers follow actual schedule creation and deletion and the execution workspace", async () => {
  const { runtime, schedules, threads, workspace, library, bridge } = await setup();
  Object.assign(bridge, {
    subscribeUpdate: () => () => {},
    updateState: async () => ({ status: "unsupported" }),
  });
  const thread = await runtime.runPromise(threads.create(workspace.id));
  library.threads = [{ ...thread.thread, projectId: workspace.projectId }];
  library.workspaces = [
    { ...workspace, kind: "worktree" },
    { ...workspace, id: "root-display", cwd: `${workspace.cwd}-root`, kind: "project-root" },
  ];
  let selected: string | undefined;
  function Sidebar() {
    const controller = useSchedules();
    return createElement(DesktopSidebar, {
      library,
      schedules: controller,
      scheduleView: false,
      onScheduleView: () => {},
      onScheduleSaved: () => {},
      runningThreadIds: new Set([thread.id]),
      workspaceId: "root-display",
      threadId: thread.id,
      busy: false,
      collapsed: false,
      onExpand: () => {},
      onSelect: (id) => {
        selected = id;
      },
      onNew: () => {},
      onChoose: () => {},
      onSettings: () => {},
      onSkills: () => {},
    });
  }
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Sidebar))));
  const projectButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.title === `${workspace.cwd}-root`,
  )!;
  await act(async () => projectButton.click());
  await expect.poll(() => document.querySelector('[aria-label="使用 worktree"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="有定时任务"]')).toBeNull();
  let scheduleId: string | undefined;
  await act(async () => {
    scheduleId = (
      await runtime.runPromise(
        schedules.write({
          threadId: thread.id,
          requestId: "marker-create",
          change: {
            action: "create",
            name: "Marker",
            prompt: "Review",
            rule: { type: "interval", everyMs: 300000, anchorAt: Date.now() + 3600000 },
          },
        }),
      )
    ).scheduleId;
  });
  await expect.poll(() => document.querySelector('[aria-label="有定时任务"]')).not.toBeNull();
  const row = document.querySelector('[aria-label="有定时任务"]')!.closest("button")!;
  expect(row.textContent).toContain("正在运行");
  await act(async () => row.click());
  expect(selected).toBe(thread.id);
  await act(async () => {
    await runtime.runPromise(
      schedules.write({
        threadId: thread.id,
        requestId: "marker-delete",
        change: { action: "delete", scheduleId: scheduleId!, expectedRevision: 1 },
      }),
    );
  });
  await expect.poll(() => document.querySelector('[aria-label="有定时任务"]')).toBeNull();
  expect(document.querySelector('[aria-label="使用 worktree"]')).not.toBeNull();
});

test("the bell shows cross-project input priority and opening a row preserves that order", async () => {
  const { runtime, threads, workspace, library, bridge } = await setup();
  Object.assign(bridge, {
    subscribeUpdate: () => () => {},
    updateState: async () => ({ status: "unsupported" }),
  });
  const first = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.rename(first.id, "First visited"));
  const projects = await runtime.runPromise(ProjectService);
  const workspaces = await runtime.runPromise(WorkspaceService);
  const otherPath = join(workspace.cwd, "other-project");
  await mkdir(otherPath);
  const otherProject = await runtime.runPromise(projects.register({ rootPath: otherPath }));
  const otherWorkspace = (await runtime.runPromise(workspaces.list(otherProject.id)))[0];
  library.projects = [...library.projects, otherProject];
  library.workspaces = [...library.workspaces, otherWorkspace];
  const second = await runtime.runPromise(threads.create(otherWorkspace.id));
  await runtime.runPromise(threads.rename(second.id, "Second visited"));
  library.threads = [
    await runtime.runPromise(threads.get(first.id)),
    await runtime.runPromise(threads.get(second.id)),
  ];
  const saved = new Map<string, string>();
  let now = Date.now();
  let recents = new ThreadRecents(
    {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
    },
    () => now,
  );
  const tabs = new DesktopTabs();
  const disconnect = recents.connect(new EventTarget());
  cleanups.push(async () => disconnect());
  tabs.openThread(first.id, workspace.id);
  recents.recordInput(first.id);
  now += 1000;
  tabs.openThread(second.id, otherWorkspace.id);
  recents.recordInput(second.id);
  function Sidebar() {
    const controller = useSchedules();
    const visits = useSyncExternalStore(recents.subscribe, recents.getSnapshot);
    const state = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
    const active = state.tabs.find((tab) => tab.id === state.activeId);
    return createElement(DesktopSidebar, {
      library,
      schedules: controller,
      visits,
      scheduleView: false,
      onScheduleView: () => {},
      onScheduleSaved: () => {},
      runningThreadIds: new Set<string>(),
      workspaceId: workspace.id,
      threadId: active?.kind === "conversation" ? (active.threadId ?? null) : null,
      busy: false,
      collapsed: false,
      onExpand: () => {},
      onSelect: (id) =>
        tabs.openThread(id, library.threads.find((thread) => thread.id === id)!.workspaceId),
      onNew: () => {},
      onChoose: () => {},
      onSettings: () => {},
      onSkills: () => {},
    });
  }
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Sidebar))));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="最近聊天"]')!.click(),
  );
  const rows = () =>
    [...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="项目与会话"] button')].filter(
      (button) => ["First visited", "Second visited"].includes(button.title),
    );
  expect(rows().map((row) => row.title)).toEqual(["Second visited", "First visited"]);
  expect(rows()[0].textContent).toContain(otherProject.name);
  expect(rows()[1].textContent).toContain(library.projects[0].name);
  const visitOrder = recents.getSnapshot();
  await runtime.runPromise(threads.rename(first.id, "First visited"));
  library.threads = [
    await runtime.runPromise(threads.get(first.id)),
    await runtime.runPromise(threads.get(second.id)),
  ];
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Sidebar))));
  expect(recents.getSnapshot()).toBe(visitOrder);
  expect(rows().map((row) => row.title)).toEqual(["Second visited", "First visited"]);
  now += 1000;
  await act(async () => rows()[1].click());
  expect(rows().map((row) => row.title)).toEqual(["Second visited", "First visited"]);
  await act(async () => recents.recordInput(first.id));
  expect(rows().map((row) => row.title)).toEqual(["First visited", "Second visited"]);
  expect(
    new ThreadRecents({
      getItem: (key) => saved.get(key) ?? null,
      setItem: () => {},
    }).getSnapshot()[0].threadId,
  ).toBe(first.id);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="最近聊天"]')!.click(),
  );
  expect(rows()).toEqual([]);
  await act(async () => root.unmount());
  recents = new ThreadRecents({
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  root = createRoot(document.body.firstElementChild!);
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Sidebar))));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="最近聊天"]')!.click(),
  );
  expect(rows().map((row) => row.title)).toEqual(["First visited", "Second visited"]);
});

test("successful composer inputs update recents for drafts and existing chats; rejection does not", async () => {
  const { workspace, library, bridge } = await setup();
  let reject = true;
  Object.assign(bridge, {
    // This transport fixture exercises admission; native worker startup is outside jsdom.
    openThread: async (id: string) =>
      ({
        id,
        model: {
          provider: "schedule-ui",
          id: "one",
          name: "one",
          contextWindow: 64000,
          thinkingLevels: ["off"],
        },
        snapshot: {
          configuration: {
            model: { provider: "schedule-ui", modelId: "one" },
            thinkingLevel: "off",
          },
          transcript: [],
          operation: null,
          lastResult: null,
          faulted: false,
        },
        contextTokens: 0,
      }) satisfies SessionResponse,
    subscribe: () => () => {},
    submit: async () => {
      if (reject) throw new Error("Input rejected");
      return { operationId: "input-admitted", kind: "run", startedAt: Date.now() };
    },
  });
  const recents = new ThreadRecents({ getItem: () => null, setItem: () => {} });
  recents.recordInput("earlier-thread");
  const tabs = new DesktopTabs();
  const activity = new ThreadActivity(window.eta);
  cleanups.push(async () => activity.dispose());
  tabs.updateConversation(tabs.activeTab.id, { workspaceId: workspace.id });
  const desktop = {
    library,
    error: null,
    busy: false,
    mainModel: undefined,
    selectMainModel: () => {},
    refresh: async () => library,
    reload: () => {},
    act: async (action: () => Promise<void>) => {
      await action();
    },
    updateSettings: async () => {},
    clearError: () => {},
  } satisfies DesktopLibraryController;
  let input: ReturnType<typeof useDesktopController>["composer"];
  function Composer() {
    const state = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
    const visits = useSyncExternalStore(recents.subscribe, recents.getSnapshot);
    const tab = state.tabs.find((tab) => tab.id === state.activeId)!;
    if (tab.kind !== "conversation") throw new Error("Expected conversation");
    const controller = useDesktopController(
      tab,
      desktop,
      {
        tabs,
        state,
        activity,
        visits,
        runningThreadIds: new Set(),
        recordInput: recents.recordInput,
      },
      true,
      0,
    );
    input = controller.composer;
    return null;
  }
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Composer))));
  const before = recents.getSnapshot();
  await act(async () => {
    await expect(input.onSubmit("First input")).rejects.toThrow("Input rejected");
  });
  expect(recents.getSnapshot()).toBe(before);
  const persisted = tabs.activeTab;
  expect(persisted.kind === "conversation" && persisted.threadId).toBeTruthy();
  reject = false;
  await expect
    .poll(async () => {
      await act(async () => {});
      return Boolean(input.disabled);
    })
    .toBe(false);
  await act(async () => input.onSubmit("Retry input"));
  expect(recents.getSnapshot()[0].threadId).toBe(
    persisted.kind === "conversation" && persisted.threadId,
  );
  await act(async () => {
    tabs.newConversation(workspace.id);
  });
  await act(async () =>
    root.render(
      createElement(ToastProvider, null, createElement(Composer, { key: tabs.activeTab.id })),
    ),
  );
  await act(async () => input.onSubmit("New chat input"));
  const created = tabs.activeTab;
  expect(created.kind === "conversation" && created.threadId).toBeTruthy();
  expect(created.kind === "conversation" && created.threadId).not.toBe(
    persisted.kind === "conversation" && persisted.threadId,
  );
  expect(recents.getSnapshot()[0].threadId).toBe(
    created.kind === "conversation" && created.threadId,
  );
});
