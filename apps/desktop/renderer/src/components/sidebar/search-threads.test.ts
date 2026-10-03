import { expect, test } from "vite-plus/test";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { searchThreads } from "./search-threads";

function thread(
  id: string,
  workspaceId: string,
  title: string,
  modifiedAt: number,
  archivedAt?: number,
): DesktopLibrary["threads"][number] {
  return {
    id,
    workspaceId,
    title,
    createdAt: 0,
    archivedAt,
    sessionRef: {
      backendId: "eta",
      metadata: {
        id,
        cwd: "/test",
        path: `/test/${id}`,
        createdAt: 0,
        modifiedAt,
        storageVersion: 1,
      },
    },
  };
}
const library: DesktopLibrary = {
  projects: [
    { id: "eta", name: "Eta", environmentId: "local", rootPath: "/eta", createdAt: 0 },
    { id: "docs", name: "文档", environmentId: "local", rootPath: "/docs", createdAt: 0 },
  ],
  workspaces: [
    { id: "root", projectId: "eta", cwd: "/eta", kind: "project-root", createdAt: 0 },
    { id: "tree", projectId: "eta", cwd: "/trees/feature-search", kind: "worktree", createdAt: 0 },
    { id: "docs", projectId: "docs", cwd: "/docs", kind: "project-root", createdAt: 0 },
  ],
  threads: [
    thread("old", "root", "Fix UI", 1),
    thread("new", "tree", "调整搜索", 3),
    thread("docs", "docs", "更新说明", 2),
    thread("archived", "root", "Archived UI", 4, 10),
  ],
  settings: { defaultThinkingLevel: "off" },
  models: [],
  credentials: [],
  providers: [],
};

test("empty search lists recent active conversations across projects without changing the catalog", () => {
  const before = structuredClone(library);
  expect(searchThreads(library, "", false).map(({ thread }) => thread.id)).toEqual([
    "new",
    "docs",
    "old",
  ]);
  expect(library).toEqual(before);
});

test("matches titles and project names regardless of case or surrounding whitespace", () => {
  expect(searchThreads(library, "  fIX ui  ", false).map(({ thread }) => thread.id)).toEqual([
    "old",
  ]);
  expect(searchThreads(library, "eTa", false).map(({ thread }) => thread.id)).toEqual([
    "new",
    "old",
  ]);
  expect(searchThreads(library, "文档", false).map(({ thread }) => thread.id)).toEqual(["docs"]);
});

test("distinguishes worktree results using the workspace name", () => {
  const matches = searchThreads(library, "feature-search", false);
  expect(matches.map(({ thread }) => thread.id)).toEqual(["new"]);
  expect(matches[0]?.project).toBe("Eta · feature-search");
});

test("archive search excludes active conversations and missing matches return no results", () => {
  expect(searchThreads(library, "UI", true).map(({ thread }) => thread.id)).toEqual(["archived"]);
  expect(searchThreads(library, "does not exist", false)).toEqual([]);
  expect(searchThreads(null, "", false)).toEqual([]);
});
