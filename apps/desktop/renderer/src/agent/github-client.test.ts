import { expect, test } from "vite-plus/test";
import { GitHubClient } from "./github-client";
import type { GitHubPage } from "@eta/core/shared/github";

const query = { projectId: "project", kind: "issues" as const, state: "open" as const };
const page = (numbers: number[]): Extract<GitHubPage, { status: "ready" }> => ({
  status: "ready",
  repository: {
    projectId: "project",
    workspaceId: "workspace",
    commonDir: "/git",
    remote: "origin",
    owner: "one",
    repo: "repo",
  },
  identity: { authenticated: false, source: "anonymous" },
  fetchedAt: Date.now(),
  stale: false,
  nextCursor: "2",
  items: numbers.map((number) => ({
    number,
    title: String(number),
    state: "open",
    draft: false,
    author: "one",
    updatedAt: "2026-10-13",
    url: "https://github.com/one/repo/issues/1",
    labels: [],
  })),
});

test("pagination deduplicates stable numbers and never mixes projects", async () => {
  let calls = 0;
  const client = new GitHubClient({
    githubQuery: async () => page(++calls === 1 ? [1, 2] : [2, 3]),
  });
  await client.load("first", query);
  await client.load("first", { ...query, cursor: "2" }, true);
  expect(client.get("first").page?.items.map((item) => item.number)).toEqual([1, 2, 3]);
  expect(client.get("other").page).toBeUndefined();
});

test("disconnect clears private data and pending requests cannot restore it", async () => {
  let finish!: (value: GitHubPage) => void;
  const client = new GitHubClient({
    githubQuery: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const loading = client.load("private", query);
  client.clear();
  finish(page([1]));
  await loading;
  expect(client.get("private")).toEqual({ loading: false });
});

test("network failures keep stale pages; authentication failures clear them", async () => {
  let result: GitHubPage = page([1]);
  const client = new GitHubClient({ githubQuery: async () => result });
  await client.load("key", query);
  result = { status: "error", code: "network", message: "Offline" };
  await client.load("key", { ...query, refresh: true });
  expect(client.get("key").page?.stale).toBe(true);
  result = { status: "error", code: "unauthenticated", message: "Login changed" };
  await client.load("key", { ...query, refresh: true });
  expect(client.get("key").page).toBeUndefined();
});
