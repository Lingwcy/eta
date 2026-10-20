import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createCore, type CoreClient } from "@eta/core";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { BotProjects } from "./projects.ts";

const io = vi.hoisted(() => ({
  realpath: vi.fn<(typeof import("node:fs/promises"))["realpath"]>(),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  io.realpath.mockImplementation(fs.realpath);
  return { ...fs, realpath: io.realpath };
});

const roots: string[] = [];
const clients: CoreClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  io.realpath.mockClear();
  for (const core of clients.splice(0)) await core.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eta-project-scan-"));
  roots.push(root);
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "scope-test", models: [{ id: "one" }] }).provider);
  const core = await createCore({
    dataRoot: join(root, "data"),
    home: join(root, "home"),
    models,
    settings: { read: Effect.succeed({ defaultThinkingLevel: "off" }), subscribe: () => () => {} },
  });
  clients.push(core);
  return { root, core };
}

test.each([1, 8])(
  "a scan resolves its root a bounded number of times with %s projects",
  async (count) => {
    const { root, core } = await fixture();
    const workspaceRoot = join(root, "workspaces");
    for (let index = 0; index < count; index++)
      await mkdir(join(workspaceRoot, "project-" + index), { recursive: true });
    const discovery = new BotProjects(core, {
      dataRoot: join(root, "data"),
      adminToken: "test",
      workspaceRoot,
      runtime: { defaultThinkingLevel: "off" },
    });
    const resolutions = () =>
      io.realpath.mock.calls.filter(([path]) => path === workspaceRoot).length;
    io.realpath.mockClear();
    await discovery.refresh();
    expect(discovery.workspaceProjects.size).toBe(count);
    expect(resolutions()).toBe(2);
    // Existing projects and workspace revalidation must not re-resolve the same root per record.
    io.realpath.mockClear();
    await discovery.refresh();
    expect(discovery.workspaceProjects.size).toBe(count);
    expect(resolutions()).toBe(2);
    expect(await core.projects()).toHaveLength(count);
  },
);

test("stable scans preserve missing checkouts and internal aliases but reject escaping links", async () => {
  const { root, core } = await fixture();
  const workspaceRoot = join(root, "workspaces");
  const checkout = join(workspaceRoot, "project");
  const hidden = join(workspaceRoot, ".hidden-project");
  const outside = join(root, "outside");
  await mkdir(checkout, { recursive: true });
  await mkdir(hidden);
  await mkdir(outside);
  await symlink(hidden, join(workspaceRoot, "internal-alias"), "dir");
  await symlink(outside, join(workspaceRoot, "escape"), "dir");
  await symlink(join(root, "absent"), join(workspaceRoot, "dangling"), "dir");
  const discovery = new BotProjects(core, {
    dataRoot: join(root, "data"),
    adminToken: "test",
    workspaceRoot,
    runtime: { defaultThinkingLevel: "off" },
    projects: [{ key: "alias", rootPath: join(workspaceRoot, "internal-alias") }],
  });
  await discovery.refresh();
  const projectId = discovery.projectKeys.get("project")!;
  const aliasId = discovery.projectKeys.get("alias");
  expect(projectId).toBeTypeOf("string");
  expect(aliasId).toBeTypeOf("string");
  expect(discovery.workspaceProjects.size).toBe(2);
  expect(await core.projects()).toHaveLength(2);
  await rm(checkout, { recursive: true });
  await discovery.refresh();
  expect([...discovery.workspaceProjects.values()]).toContain(projectId);
  expect(discovery.projectKeys.get("project")).toBe(projectId);
  await symlink(outside, checkout, "dir");
  await discovery.refresh();
  expect([...discovery.workspaceProjects.values()]).not.toContain(projectId);
  expect(discovery.projectKeys.has("project")).toBe(false);
  expect(discovery.projectKeys.get("alias")).toBe(aliasId);
  expect(discovery.workspaceProjects.size).toBe(1);
});

test("a root switch invalidates both ownership maps until a fresh scan succeeds", async () => {
  const { root, core } = await fixture();
  const firstRoot = join(root, "first");
  const nextRoot = join(root, "next");
  await mkdir(join(firstRoot, "team"), { recursive: true });
  await mkdir(join(nextRoot, "team"), { recursive: true });
  const first = await core.registerProject(join(firstRoot, "team"));
  const next = await core.registerProject(join(nextRoot, "team"));
  const [firstWorkspace] = await core.workspaces(first.id);
  const [nextWorkspace] = await core.workspaces(next.id);
  const workspaceRoot = join(root, "active");
  await symlink(firstRoot, workspaceRoot, "dir");
  const discovery = new BotProjects(core, {
    dataRoot: join(root, "data"),
    adminToken: "test",
    workspaceRoot,
    runtime: { defaultThinkingLevel: "off" },
    projects: [{ key: "stable-team", rootPath: join(workspaceRoot, "team") }],
  });
  await discovery.refresh();
  expect(discovery.workspaceProjects.has(firstWorkspace!.id)).toBe(true);
  expect(discovery.projectKeys.get("stable-team")).toBe(first.id);
  const release = Promise.withResolvers<void>();
  let entered = false;
  const projects = core.projects;
  const read = vi.spyOn(core, "projects").mockImplementationOnce(async () => {
    entered = true;
    await release.promise;
    return projects();
  });
  const refreshing = discovery.refresh();
  const rejected = expect(refreshing).rejects.toMatchObject({ code: "ProjectUnavailable" });
  try {
    await expect.poll(() => entered).toBe(true);
    await rm(workspaceRoot);
    await symlink(nextRoot, workspaceRoot, "dir");
    release.resolve();
    await rejected;
    expect(discovery.workspaceProjects.size).toBe(0);
    expect(discovery.projectKeys.size).toBe(0);
    await discovery.refresh();
    expect(discovery.workspaceProjects.has(firstWorkspace!.id)).toBe(false);
    expect(discovery.workspaceProjects.has(nextWorkspace!.id)).toBe(true);
    expect(discovery.projectKeys.get("stable-team")).toBe(next.id);
  } finally {
    release.resolve();
    await refreshing.catch(() => {});
    await rejected.catch(() => {});
    read.mockRestore();
  }
});

async function scopeFixture(count = 1) {
  const { root: temporary, core } = await fixture();
  const root = await realpath(temporary);
  const workspaceRoot = join(root, "workspaces");
  for (let index = 0; index < count; index++)
    await mkdir(join(workspaceRoot, "project-" + index), { recursive: true });
  const discovery = new BotProjects(core, {
    dataRoot: join(root, "data"),
    adminToken: "test",
    workspaceRoot,
    runtime: { defaultThinkingLevel: "off" },
  });
  await discovery.refresh();
  const [workspace] = await core.workspaces();
  const thread = await core.createThread(workspace!.id);
  return { root, core, workspaceRoot, workspace: workspace!, thread, discovery };
}

test.each([1, 8])("a target check only resolves its own paths with %s projects", async (count) => {
  const { core, workspaceRoot, workspace, thread, discovery } = await scopeFixture(count);
  io.realpath.mockClear();
  await discovery.refreshForThread(thread.id);
  expect(discovery.workspaceProjects.get(workspace.id)).toBe(workspace.projectId);
  // Two root identity checks plus project and workspace paths; no unrelated filesystem traversal.
  expect(io.realpath.mock.calls.length).toBeLessThanOrEqual(4);
  expect(
    io.realpath.mock.calls.every(([path]) => path === workspaceRoot || path === workspace.cwd),
  ).toBe(true);
  expect(await core.projects()).toHaveLength(count);
});

test("target validation retains missing checkouts but revokes dangling or escaping links", async () => {
  const { root, workspace, thread, discovery } = await scopeFixture();
  await rm(workspace.cwd, { recursive: true });
  await discovery.refreshForThread(thread.id);
  expect(discovery.workspaceProjects.has(workspace.id)).toBe(true);
  await symlink(join(root, "absent"), workspace.cwd, "dir");
  await discovery.refreshForThread(thread.id);
  expect(discovery.workspaceProjects.has(workspace.id)).toBe(false);
  await rm(workspace.cwd);
  await mkdir(workspace.cwd);
  await discovery.refreshForThread(thread.id);
  expect(discovery.workspaceProjects.has(workspace.id)).toBe(true);
  const outside = join(root, "outside");
  await mkdir(outside);
  await rm(workspace.cwd, { recursive: true });
  await symlink(outside, workspace.cwd, "dir");
  await discovery.refreshForThread(thread.id);
  expect(discovery.workspaceProjects.has(workspace.id)).toBe(false);
});

test("target checks validate a worktree cwd separately from its project root", async () => {
  const { root, core, workspaceRoot, workspace, discovery } = await scopeFixture();
  const cwd = join(workspaceRoot, ".eta-worktrees", "checkout");
  await mkdir(cwd, { recursive: true });
  const worktree = await core.registerWorkspace(workspace.projectId, cwd);
  const thread = await core.createThread(worktree.id);
  await discovery.refreshForThread(thread.id);
  expect(discovery.workspaceProjects.has(worktree.id)).toBe(true);
  const outside = join(root, "outside");
  await mkdir(outside);
  await rm(cwd, { recursive: true });
  await symlink(outside, cwd, "dir");
  await discovery.refreshForThread(thread.id);
  expect(discovery.workspaceProjects.has(worktree.id)).toBe(false);
  expect(discovery.workspaceProjects.has(workspace.id)).toBe(true);
});

test("an older scan cannot overwrite a target's newly registered workspace", async () => {
  const { core, workspaceRoot, workspace, discovery } = await scopeFixture();
  const cwd = join(workspaceRoot, ".eta-worktrees", "new-checkout");
  await mkdir(cwd, { recursive: true });
  let entered = false;
  const release = Promise.withResolvers<void>();
  const list = core.workspaces;
  const read = vi.spyOn(core, "workspaces").mockImplementationOnce(async (...args) => {
    const snapshot = await list(...args);
    entered = true;
    await release.promise;
    return snapshot;
  });
  const scanning = discovery.refresh();
  let checking: Promise<void> | undefined;
  try {
    await expect.poll(() => entered).toBe(true);
    const worktree = await core.registerWorkspace(workspace.projectId, cwd);
    const thread = await core.createThread(worktree.id);
    checking = discovery.refreshForThread(thread.id);
    release.resolve();
    await scanning;
    await checking;
    expect(discovery.workspaceProjects.get(worktree.id)).toBe(workspace.projectId);
  } finally {
    release.resolve();
    await scanning.catch(() => {});
    await checking?.catch(() => {});
    read.mockRestore();
  }
});

test("a root switched before the target check revokes every old workspace and alias", async () => {
  const { root, core, workspaceRoot } = await scopeFixture(2);
  const nextRoot = join(root, "next");
  await mkdir(join(nextRoot, "team"), { recursive: true });
  const next = await core.registerProject(join(nextRoot, "team"));
  const [nextWorkspace] = await core.workspaces(next.id);
  const nextThread = await core.createThread(nextWorkspace!.id);
  const active = join(root, "active");
  await symlink(workspaceRoot, active, "dir");
  const discovery = new BotProjects(core, {
    dataRoot: join(root, "data"),
    adminToken: "test",
    workspaceRoot: active,
    runtime: { defaultThinkingLevel: "off" },
    projects: [{ key: "stable", rootPath: join(active, "project-0") }],
  });
  await discovery.refresh();
  expect(discovery.workspaceProjects.size).toBe(2);
  expect(discovery.projectKeys.has("stable")).toBe(true);
  await rm(active);
  await symlink(nextRoot, active, "dir");
  await discovery.refreshForThread(nextThread.id);
  expect([...discovery.workspaceProjects]).toEqual([[nextWorkspace!.id, next.id]]);
  expect(discovery.projectKeys.size).toBe(0);
});

test("target validation rejects a root switch during its path checks", async () => {
  const { root, core, workspaceRoot, workspace, thread } = await scopeFixture(2);
  const active = join(root, "active");
  const next = join(root, "next");
  await mkdir(next);
  await symlink(workspaceRoot, active, "dir");
  const discovery = new BotProjects(core, {
    dataRoot: join(root, "data"),
    adminToken: "test",
    workspaceRoot: active,
    runtime: { defaultThinkingLevel: "off" },
  });
  await discovery.refresh();
  const original = io.realpath.getMockImplementation()!;
  const release = Promise.withResolvers<void>();
  let entered = false;
  io.realpath.mockImplementation(async (...args) => {
    const path = await original(...args);
    if (args[0] === workspace.cwd && !entered) {
      entered = true;
      await release.promise;
    }
    return path;
  });
  const checking = discovery.refreshForThread(thread.id);
  const rejected = expect(checking).rejects.toMatchObject({ code: "ProjectUnavailable" });
  try {
    await expect.poll(() => entered).toBe(true);
    await rm(active);
    await symlink(next, active, "dir");
    release.resolve();
    await rejected;
    expect(discovery.workspaceProjects.size).toBe(0);
    expect(discovery.projectKeys.size).toBe(0);
  } finally {
    release.resolve();
    await checking.catch(() => {});
    await rejected.catch(() => {});
    io.realpath.mockImplementation(original);
  }
});

test("target checks preserve visible aliases into hidden and nested project roots", async () => {
  const { core, workspaceRoot, discovery } = await scopeFixture();
  for (const name of [".hidden", "project-0/nested"]) {
    const path = join(workspaceRoot, name);
    await mkdir(path);
    const project = await core.registerProject(path);
    const [workspace] = await core.workspaces(project.id);
    const thread = await core.createThread(workspace!.id);
    const alias = join(workspaceRoot, "alias");
    await symlink(path, alias, "dir");
    await discovery.refreshForThread(thread.id);
    expect(discovery.workspaceProjects.get(workspace!.id)).toBe(project.id);
    await rm(alias);
    await discovery.refreshForThread(thread.id);
    expect(discovery.workspaceProjects.has(workspace!.id)).toBe(false);
  }
});

test("target checks keep the full scan's duplicate direct-root selection", async () => {
  const { core, workspace, thread, discovery } = await scopeFixture();
  const projects = await core.projects();
  const duplicate = { ...projects[0]!, id: "duplicate" };
  const read = vi.spyOn(core, "projects").mockResolvedValue([...projects, duplicate]);
  try {
    await discovery.refreshForThread(thread.id);
    expect(discovery.workspaceProjects.has(workspace.id)).toBe(false);
    read.mockResolvedValue([duplicate, ...projects]);
    await discovery.refreshForThread(thread.id);
    expect(discovery.workspaceProjects.get(workspace.id)).toBe(workspace.projectId);
  } finally {
    read.mockRestore();
  }
});

test.each(["scan", "target"])(
  "an older target cannot undo a completed %s revocation",
  async (actor) => {
    const { root, workspaceRoot, workspace, thread, discovery } = await scopeFixture();
    const original = io.realpath.getMockImplementation()!;
    const release = Promise.withResolvers<void>();
    let rootReads = 0;
    let entered = false;
    io.realpath.mockImplementation(async (...args) => {
      const path = await original(...args);
      if (args[0] === workspaceRoot && ++rootReads === 2) {
        entered = true;
        await release.promise;
      }
      return path;
    });
    const checking = discovery.refreshForThread(thread.id);
    try {
      await expect.poll(() => entered).toBe(true);
      const outside = join(root, "outside");
      await mkdir(outside);
      await rm(workspace.cwd, { recursive: true });
      await symlink(outside, workspace.cwd, "dir");
      if (actor === "scan") await discovery.refresh();
      else await discovery.refreshForThread(thread.id);
      expect(discovery.workspaceProjects.has(workspace.id)).toBe(false);
      release.resolve();
      await checking;
      expect(discovery.workspaceProjects.has(workspace.id)).toBe(false);
    } finally {
      release.resolve();
      await checking;
      io.realpath.mockImplementation(original);
    }
  },
);

test("a late old-root check cannot replace the newer root's ownership", async () => {
  const { root, core, workspaceRoot, thread } = await scopeFixture(2);
  const active = join(root, "active");
  const nextRoot = join(root, "next");
  await symlink(workspaceRoot, active, "dir");
  await mkdir(join(nextRoot, "team"), { recursive: true });
  const next = await core.registerProject(join(nextRoot, "team"));
  const [nextWorkspace] = await core.workspaces(next.id);
  const nextThread = await core.createThread(nextWorkspace!.id);
  const discovery = new BotProjects(core, {
    dataRoot: join(root, "data"),
    adminToken: "test",
    workspaceRoot: active,
    runtime: { defaultThinkingLevel: "off" },
  });
  await discovery.refresh();
  const original = io.realpath.getMockImplementation()!;
  const release = Promise.withResolvers<void>();
  let rootReads = 0;
  let entered = false;
  io.realpath.mockImplementation(async (...args) => {
    const path = await original(...args);
    if (args[0] === active && ++rootReads === 2) {
      entered = true;
      await release.promise;
    }
    return path;
  });
  const checking = discovery.refreshForThread(thread.id);
  try {
    await expect.poll(() => entered).toBe(true);
    await rm(active);
    await symlink(nextRoot, active, "dir");
    await discovery.refreshForThread(nextThread.id);
    expect([...discovery.workspaceProjects]).toEqual([[nextWorkspace!.id, next.id]]);
    release.resolve();
    await checking;
    expect([...discovery.workspaceProjects]).toEqual([[nextWorkspace!.id, next.id]]);
    expect(discovery.projectKeys.has("project-0")).toBe(false);
  } finally {
    release.resolve();
    await checking.catch(() => {});
    io.realpath.mockImplementation(original);
  }
});
