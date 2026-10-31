// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InspectorTabs, type InspectorContent } from "./inspector-tabs";
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function tab(label: string) {
  return document.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${label}"]`);
}
function activeContent() {
  return [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].find(
    (panel) => !panel.hidden,
  )?.textContent;
}
test("sidebar tabs switch content without losing state or closing the sidebar", async () => {
  function Github() {
    const [count, setCount] = useState(0);
    return createElement(
      "button",
      { onClick: () => setCount(count + 1), "aria-label": "refresh" },
      `GitHub ${count}`,
    );
  }
  function Inspector() {
    const [value, setValue] = useState<InspectorContent>("github");
    return createElement(InspectorTabs, {
      value,
      onChange: setValue,
      github: createElement(Github),
      subagents: "Agents",
      diff: "Changes",
    });
  }
  await act(async () => root.render(createElement(Inspector)));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="refresh"]')!.click(),
  );
  await act(async () => tab("子智能体")!.click());
  expect(activeContent()).toBe("Agents");
  await act(async () => tab("GitHub")!.click());
  expect(activeContent()).toBe("GitHub 1");
  await act(async () => tab("代码差异")!.click());
  expect(activeContent()).toBe("Changes");
  await act(async () => tab("GitHub")!.click());
  expect(activeContent()).toBe("GitHub 1");
});
test("only available capabilities appear and removing the selected capability reveals remaining content", async () => {
  await act(async () =>
    root.render(
      createElement(InspectorTabs, {
        value: "github",
        onChange: () => {},
        github: "Pulls",
        subagents: "Agents",
      }),
    ),
  );
  expect(activeContent()).toBe("Pulls");
  await act(async () =>
    root.render(
      createElement(InspectorTabs, { value: "github", onChange: () => {}, subagents: "Agents" }),
    ),
  );
  expect(tab("GitHub")).toBeNull();
  expect(tab("子智能体")).not.toBeNull();
  expect(activeContent()).toBe("Agents");
  await act(async () =>
    root.render(
      createElement(InspectorTabs, {
        value: "subagents",
        onChange: () => {},
        github: "Other repository",
      }),
    ),
  );
  expect(tab("子智能体")).toBeNull();
  expect(activeContent()).toBe("Other repository");
});
