// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { useDesktopShell } from "./use-desktop-shell";

const fixture = vi.hoisted(() => ({
  github: false,
  diff: false,
  openDiff: undefined as (() => void) | undefined,
}));
vi.mock("./use-desktop-library", () => ({
  useDesktopLibrary: () => ({
    library: {
      projects: [{ id: "project", name: "Repo" }],
      workspaces: [{ id: "workspace", projectId: "project", kind: "project-root" }],
      threads: [],
    },
  }),
}));
vi.mock("./use-schedules", () => ({ useSchedules: () => ({}) }));
vi.mock("./use-subagents", () => ({ useSubagents: () => ({ agents: [], revision: 0 }) }));
vi.mock("./use-desktop-tabs", () => ({
  useDesktopTabs: () => ({
    state: {
      tabs: [{ id: "draft", kind: "conversation", workspaceId: "workspace" }],
      history: ["draft"],
      historyIndex: 0,
    },
    tabs: {},
  }),
}));
vi.mock("./use-project-git", () => ({
  useProjectGit: () => ({ info: fixture.github ? { status: "ready", github: {} } : undefined }),
}));
vi.mock("./use-code-diff", () => ({
  useCodeDiff: ({ onOpen }: { onOpen: () => void }) => {
    fixture.openDiff = onOpen;
    return { available: fixture.diff };
  },
}));
vi.mock("./use-desktop-shortcuts", () => ({ useDesktopShortcuts: () => () => {} }));
vi.mock("@/browser/use-browser-pages", () => ({ useBrowserPages: () => ({ pages: [] }) }));
vi.mock("./use-tab-presentations", () => ({ useTabPresentations: () => ({ items: [] }) }));

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  fixture.github = false;
  fixture.diff = false;
  fixture.openDiff = undefined;
});

test.each(["github", "diff"] as const)(
  "%s availability does not open the sidebar; users can open and close it",
  async (kind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "eta", { configurable: true, value: {} });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    function Harness() {
      const shell = useDesktopShell();
      return createElement(
        "button",
        {
          disabled: !shell.inspectorAvailable,
          "aria-expanded": shell.inspectorOpen,
          onClick: shell.toggleInspector,
        },
        shell.inspectorContent,
      );
    }
    await act(async () => root!.render(createElement(Harness)));
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    fixture[kind] = true;
    await act(async () => root!.render(createElement(Harness)));
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.textContent).toBe(kind);
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("false");
  },
);

test("an explicit diff action opens the sidebar even when initially collapsed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "eta", { configurable: true, value: {} });
  fixture.diff = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    const shell = useDesktopShell();
    return createElement("div", { "aria-expanded": shell.inspectorOpen }, shell.inspectorContent);
  }
  await act(async () => root!.render(createElement(Harness)));
  expect(container.firstElementChild?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => fixture.openDiff!());
  expect(container.firstElementChild?.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toBe("diff");
});
