import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createCore, type CoreClient } from "@eta/core";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { BotProjects } from "./projects.ts";

const roots: string[] = [];
const clients: CoreClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of clients.splice(0)) await core.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eta-scan-index-")));
  roots.push(root);
  const core = await createCore({
    dataRoot: join(root, "data"),
    home: join(root, "home"),
    models: createModels(),
    settings: { read: Effect.succeed({ defaultThinkingLevel: "off" }), subscribe: () => () => {} },
  });
  clients.push(core);
  const workspaceRoot = join(root, "workspaces");
  await mkdir(workspaceRoot);
  const discovery = new BotProjects(core, {
    dataRoot: join(root, "data"),
    adminToken: "test",
    workspaceRoot,
    runtime: { defaultThinkingLevel: "off" },
  });
  return { root, core, workspaceRoot, discovery };
}

test.each([8, 32])(
  "metadata traversal is linear when scanning %s registered projects",
  async (count) => {
    const { core, workspaceRoot, discovery } = await fixture();
    for (let index = 0; index < count; index++) {
      const path = join(workspaceRoot, "project-" + index);
      await mkdir(path);
      await core.registerProject(path);
    }
    const stored = await core.projects();
    let reads = 0;
    const counted = stored.map((project) => ({
      ...project,
      get rootPath() {
        reads++;
        return project.rootPath;
      },
    }));
    vi.spyOn(core, "projects").mockResolvedValue(counted);
    const registration = vi.spyOn(core, "registerProject");
    await discovery.refresh();
    expect([...discovery.workspaceProjects.values()].sort()).toEqual(
      stored.map((project) => project.id).sort(),
    );
    expect(discovery.projectKeys.size).toBe(count);
    expect(registration).not.toHaveBeenCalled();
    // Count actual metadata access, not elapsed time or the particular index implementation.
    expect(reads).toBeLessThanOrEqual(5 * count);
    reads = 0;
    await discovery.refresh();
    expect(reads).toBeLessThanOrEqual(5 * count);
    expect(registration).not.toHaveBeenCalled();
  },
);

test("indexes retain new and missing projects while rejecting outside workspaces", async () => {
  const { root, core, workspaceRoot, discovery } = await fixture();
  const missingPath = join(workspaceRoot, "missing");
  await mkdir(missingPath);
  const missing = await core.registerProject(missingPath);
  await rm(missingPath, { recursive: true });
  const outsidePath = join(root, "outside");
  await mkdir(outsidePath);
  const outside = await core.registerProject(outsidePath);
  await symlink(outsidePath, join(workspaceRoot, "escape"), "dir");
  const freshPath = join(workspaceRoot, "fresh");
  await mkdir(freshPath);
  await discovery.refresh();
  const fresh = (await core.projects()).find((project) => project.rootPath === freshPath)!;
  expect(fresh).toBeDefined();
  expect([...discovery.workspaceProjects.values()].sort()).toEqual([missing.id, fresh.id].sort());
  expect(discovery.projectKeys.get("fresh")).toBe(fresh.id);
  expect(discovery.projectKeys.get("missing")).toBe(missing.id);
  expect([...discovery.workspaceProjects.values()]).not.toContain(outside.id);
  expect(discovery.projectKeys.has("escape")).toBe(false);
  await rm(freshPath, { recursive: true });
  await symlink(outsidePath, freshPath, "dir");
  await discovery.refresh();
  expect([...discovery.workspaceProjects.values()]).toEqual([missing.id]);
});

test("canonical aliases keep the first matching project when paths are duplicated", async () => {
  const { core, workspaceRoot, discovery } = await fixture();
  const hiddenPath = join(workspaceRoot, ".hidden");
  await mkdir(hiddenPath);
  await symlink(hiddenPath, join(workspaceRoot, "visible"), "dir");
  const registered = await core.registerProject(hiddenPath);
  const canonical = await realpath(hiddenPath);
  // The adapter previously used find(): retain that first-match behavior even for a duplicate feed.
  vi.spyOn(core, "projects").mockResolvedValue([registered, { ...registered, id: "duplicate" }]);
  const registration = vi.spyOn(core, "registerProject");
  await discovery.refresh();
  expect(discovery.projectKeys.get(".hidden")).toBe(registered.id);
  expect([...discovery.workspaceProjects.values()]).toEqual([registered.id]);
  expect(registration).not.toHaveBeenCalled();
  expect(registered.rootPath).toBe(canonical);
});
