import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import type { CatalogState } from "../service/catalog/type.ts";
import { scanStorage, storageTargetPath } from "./index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eta-storage-"));
  roots.push(root);
  const file = async (name: string, size: number) => {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, Buffer.alloc(size));
    return path;
  };
  const thread = (id: string, session: string, archivedAt?: number) => ({
    id,
    workspaceId: "workspace",
    title: `Chat ${id}`,
    createdAt: 1,
    archivedAt,
    sessionRef: {
      backendId: "eta" as const,
      metadata: {
        id: session,
        path: join(root, "sessions", session),
        cwd: "/project",
        storageVersion: 1,
        createdAt: 1,
        modifiedAt: 1,
      },
    },
  });
  const catalog: CatalogState = {
    projects: [
      {
        id: "project",
        environmentId: "local",
        name: "Project",
        rootPath: "/project",
        createdAt: 1,
      },
    ],
    workspaces: [
      {
        id: "workspace",
        projectId: "project",
        kind: "project-root",
        cwd: "/project",
        createdAt: 1,
      },
    ],
    threads: [thread("one", "one"), thread("two", "two", 2)],
  };
  return { root, file, catalog, thread };
}

test("counts sessions once without scanning configuration or browser data", async () => {
  const { root, file, catalog, thread } = await fixture();
  await file("sessions/one/main.jsonl", 10);
  await file("sessions/one/doc-1.jsonl", 20);
  await file("sessions/one/task-2.jsonl", 30);
  await file("sessions/one/identity.json", 5);
  await file("sessions/two/main.jsonl", 8);
  await file("sessions/unknown/main.jsonl", 9);
  await file("sessions/.trash/old/main.jsonl", 7);
  await file("settings.json", 11);
  await file("credentials.json", 12);
  await file("Partitions/eta-browser/Cache/data", 13);
  await file("Local Storage/data", 14);
  const report = await scanStorage(root, {
    ...catalog,
    threads: [...catalog.threads, thread("branch", "one")],
  });
  expect(report.sessionBytes).toBe(89);
  expect(report.sessions).toHaveLength(4);
  expect(report.sessions.find((session) => session.id === "one")?.bytes).toBe(65);
  expect(report.sessions.find((session) => session.id === "two")?.project).toBe("Project");
  await symlink("nonexistent", join(root, "SingletonLock"));
  expect((await scanStorage(root, catalog)).issues).toEqual([]);
  expect(report.issues).toEqual([]);
});

test("missing sessions remain visible with an unknown size", async () => {
  const { root, catalog } = await fixture();
  const report = await scanStorage(root, catalog);
  expect(report.sessions).toHaveLength(2);
  expect(report.sessions.every((session) => session.bytes === null)).toBe(true);
  expect(report.issues).toHaveLength(2);
  expect(report.sessionBytes).toBe(0);
});

test("reports the three native data paths without reading configuration contents", async () => {
  const { root, file, catalog } = await fixture();
  await file("settings.json", 11);
  await file("catalog.json", 13);
  const report = await scanStorage(root, catalog);
  expect(report.paths).toEqual({
    sessions: join(root, "sessions"),
    modelConfiguration: join(root, "settings.json"),
    catalog: join(root, "catalog.json"),
  });
  expect(await storageTargetPath(root, { kind: "configuration", id: "catalog.json" })).toBe(
    await realpath(report.paths.catalog),
  );
  await expect(
    storageTargetPath(root, { kind: "configuration", id: "credentials.json" }),
  ).rejects.toThrow("配置文件无效");
});

test("Finder or Explorer targets resolve to existing sessions root, configuration and session paths", async () => {
  const { root, file } = await fixture();
  const config = await file("settings.json", 1);
  await file("sessions/one/main.jsonl", 1);
  expect(await storageTargetPath(root, { kind: "sessions" })).toBe(
    await realpath(join(root, "sessions")),
  );
  expect(await storageTargetPath(root, { kind: "configuration", id: "settings.json" })).toBe(
    await realpath(config),
  );
  expect(await storageTargetPath(root, { kind: "session", id: "one" })).toBe(
    await realpath(join(root, "sessions", "one")),
  );
  await expect(
    storageTargetPath(root, { kind: "configuration", id: "../settings.json" }),
  ).rejects.toThrow();
  await expect(storageTargetPath(root, { kind: "session", id: "..\\outside" })).rejects.toThrow();
  await expect(
    storageTargetPath(root, { kind: "configuration", id: "missing.json" }),
  ).rejects.toThrow();
});

test("external directory links are neither counted nor revealed", async () => {
  const { root, file, catalog } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "eta-storage-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "large.jsonl"), Buffer.alloc(100));
  await file("sessions/one/main.jsonl", 1);
  await file("sessions/two/main.jsonl", 2);
  await symlink(outside, join(root, "sessions", "external"), "junction");
  const report = await scanStorage(root, catalog);
  expect(report.sessionBytes).toBe(3);
  expect(report.issues.some((issue) => issue.includes("符号链接"))).toBe(true);
  await expect(storageTargetPath(root, { kind: "session", id: "external" })).rejects.toThrow(
    "不在应用数据目录",
  );
});

test("a linked sessions root is not traversed", async () => {
  const { root, catalog } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "eta-storage-outside-"));
  roots.push(outside);
  await symlink(outside, join(root, "sessions"), "junction");
  await expect(scanStorage(root, catalog)).rejects.toThrow("会话总目录不能是符号链接");
});
