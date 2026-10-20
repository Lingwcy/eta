import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
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
  const core = await createCore({
    dataRoot: join(root, "data"),
    home: join(root, "home"),
    models: createModels(),
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
