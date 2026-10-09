import { expect, test } from "vite-plus/test";
import type { CatalogState } from "../../../../shared/catalog.ts";
import type { ThreadMetadata } from "../../../../shared/threads.ts";
import { validateCatalog } from "../invariants.ts";

function thread(id: string, workspaceId: string, cwd: string, sessionId = id): ThreadMetadata {
  return {
    id,
    workspaceId,
    title: id,
    createdAt: 1,
    sessionRef: {
      backendId: "eta",
      metadata: {
        id: sessionId,
        cwd,
        path: `/sessions/${id}.jsonl`,
        storageVersion: 1,
        createdAt: 1,
        modifiedAt: 1,
      },
    },
  };
}

function catalog(): CatalogState {
  return {
    projects: [
      { id: "project", environmentId: "local", name: "Eta", rootPath: "/repo", createdAt: 1 },
    ],
    workspaces: [
      { id: "root", projectId: "project", cwd: "/repo", kind: "project-root", createdAt: 1 },
      { id: "worktree", projectId: "project", cwd: "/worktree", kind: "worktree", createdAt: 1 },
    ],
    threads: [thread("first", "root", "/repo"), thread("second", "worktree", "/worktree")],
  };
}

test("accepts an empty catalog and valid project-root and worktree relationships", () => {
  expect(validateCatalog({ projects: [], workspaces: [], threads: [] })).toEqual([]);
  expect(validateCatalog(catalog())).toEqual([]);
});

test.each(["projects", "workspaces", "threads"] as const)(
  "rejects duplicate IDs within %s",
  (key) => {
    const state = catalog();
    const invalid = { ...state, [key]: [...state[key], state[key][0]!] };
    expect(validateCatalog(invalid)).toContainEqual({
      code: "DuplicateId",
      message: expect.stringContaining(state[key][0]!.id),
    });
  },
);

test("allows the same ID across different object kinds", () => {
  const state = catalog();
  expect(
    validateCatalog({
      projects: state.projects,
      workspaces: [{ ...state.workspaces[0]!, id: "project" }],
      threads: [thread("project", "project", "/repo")],
    }),
  ).toEqual([]);
});

test("reports missing references together without inventing path mismatch errors", () => {
  const state = catalog();
  const violations = validateCatalog({
    ...state,
    projects: [],
    workspaces: [state.workspaces[0]!],
  });
  expect(violations.map(({ code }) => code)).toEqual(["ProjectNotFound", "WorkspaceNotFound"]);
  expect(violations[0]!.message).toContain("root");
  expect(violations[1]!.message).toContain("second");
});

test("rejects a project-root workspace whose cwd differs from its project root", () => {
  const state = catalog();
  expect(
    validateCatalog({ ...state, projects: [{ ...state.projects[0]!, rootPath: "/other" }] }),
  ).toEqual([{ code: "WorkspaceRootMismatch", message: expect.stringContaining("root") }]);
});

test("rejects a session whose cwd differs from its thread workspace", () => {
  const state = catalog();
  expect(validateCatalog({ ...state, threads: [thread("first", "root", "/other")] })).toEqual([
    { code: "SessionWorkspaceMismatch", message: expect.stringContaining("first") },
  ]);
});

test("rejects duplicate session bindings even for archived threads or missing workspaces", () => {
  const state = catalog();
  const violations = validateCatalog({
    ...state,
    threads: [
      thread("first", "root", "/repo", "shared"),
      { ...thread("archived", "missing", "/repo", "shared"), archivedAt: 2 },
    ],
  });
  expect(violations.map(({ code }) => code)).toEqual([
    "WorkspaceNotFound",
    "DuplicateSessionBinding",
  ]);
  expect(violations[1]!.message).toContain("first");
  expect(violations[1]!.message).toContain("archived");
});

test("allows identical session IDs in different cwd directories", () => {
  const state = catalog();
  expect(
    validateCatalog({
      ...state,
      threads: [
        thread("first", "root", "/repo", "shared"),
        thread("second", "worktree", "/worktree", "shared"),
      ],
    }),
  ).toEqual([]);
});

test("allows multiple independent sessions in one workspace without mutating the catalog", () => {
  const state = catalog();
  const input = {
    ...state,
    threads: [thread("first", "root", "/repo"), thread("second", "root", "/repo")],
  };
  const original = structuredClone(input);
  expect(validateCatalog(input)).toEqual([]);
  expect(input).toEqual(original);
});
