import type { CatalogState } from "@eta/core/shared/catalog";

export function catalogFixture(): CatalogState {
  return {
    projects: [
      { id: "project", environmentId: "local", name: "Eta", rootPath: "/repo", createdAt: 1 },
    ],
    workspaces: [
      { id: "root", projectId: "project", cwd: "/repo", kind: "project-root", createdAt: 1 },
    ],
    threads: [
      {
        id: "thread",
        workspaceId: "root",
        title: "First thread",
        createdAt: 1,
        sessionRef: {
          backendId: "eta",
          metadata: {
            id: "session",
            cwd: "/repo",
            path: "/sessions/thread.jsonl",
            storageVersion: 1,
            createdAt: 1,
            modifiedAt: 1,
            parentSessionId: "parent-session",
            legacyParentSessionPath: "/sessions/legacy.jsonl",
          },
        },
      },
    ],
  };
}
