// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vite-plus/test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitRepositoryInfo } from "@eta/core/shared/git";
import type { GitHubQuery } from "@eta/core/shared/github";
import { GitHubClient } from "@/agent/github-client";
import { InspectorTabs } from "@/components/inspector/inspector-tabs";
import { GitHubPanel } from "./github-panel";
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
test("GitHub categories live in the header, default to open and retain options outside the list", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const info: GitRepositoryInfo = {
    status: "ready",
    workspaceId: "workspace",
    root: "/repo",
    gitDir: "/git",
    commonDir: "/git",
    prefix: "",
    linkedWorktree: false,
    head: { kind: "branch", name: "main", sha: "a" },
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    remotes: [
      {
        name: "origin",
        url: "https://github.com/one/repo",
        github: { host: "github.com", owner: "one", repo: "repo" },
      },
    ],
    github: {
      candidates: ["origin"],
      selection: { remote: "origin", owner: "one", repo: "repo", reason: "origin" },
    },
  };
  const query = vi.fn(async (input: GitHubQuery) => ({
    status: "ready" as const,
    repository: {
      projectId: "project",
      workspaceId: "workspace",
      commonDir: "/git",
      remote: "origin",
      owner: "one",
      repo: "repo",
    },
    identity: { authenticated: false, source: "anonymous" as const },
    fetchedAt: Date.now(),
    stale: false,
    items: [
      {
        number: 1,
        title: input.kind === "pulls" ? "A pull request" : "An issue",
        state: "open" as const,
        draft: false,
        author: "one",
        updatedAt: "2026-10-13",
        url: "https://github.com/one/repo/issues/1",
        labels: [],
      },
    ],
  }));
  const client = new GitHubClient({ githubQuery: query });
  client.filters.set("project:pulls", { kind: "pulls", state: "closed" });
  const refresh = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(InspectorTabs, {
        value: "github",
        onChange: () => {},
        github: createElement(GitHubPanel, {
          client,
          projectId: "project",
          name: "Repo",
          info,
          connected: true,
          onRefresh: refresh,
          onRemote: async () => {},
        }),
      }),
    ),
  );
  expect(query).toHaveBeenLastCalledWith({ projectId: "project", kind: "pulls", state: "open" });
  const panel = document.querySelector('[role="tabpanel"]')!;
  expect(panel.textContent).toContain("A pull request");
  expect(panel.textContent).not.toContain("GitHub · Repo");
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find((value) => value.textContent === text)!;
  expect(panel.contains(button("PR"))).toBe(false);
  await act(async () => button("Issues").click());
  expect(query).toHaveBeenLastCalledWith({ projectId: "project", kind: "issues", state: "open" });
  expect(panel.textContent).toContain("An issue");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="GitHub 列表选项"]')!.click(),
  );
  expect(document.querySelector('select[aria-label="GitHub remote"]')).not.toBeNull();
  expect(
    document.querySelector<HTMLSelectElement>('select[aria-label="GitHub 状态筛选"]')!.value,
  ).toBe("open");
  await act(async () => button("刷新").click());
  expect(refresh).toHaveBeenCalledOnce();
  expect(query).toHaveBeenLastCalledWith({
    projectId: "project",
    kind: "issues",
    state: "open",
    refresh: true,
  });
});
