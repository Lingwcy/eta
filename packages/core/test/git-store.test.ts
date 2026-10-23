import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore, type CoreClient } from "../src/client.ts";
import { AppPathsService } from "../src/platform/app-paths.ts";
import {
  GitStoreService,
  WorktreeReceiptSchema,
  type WorktreeReceipt,
} from "../src/service/git/store.ts";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const core of clients.splice(0)) await core.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "eta-git-store-"));
  directories.push(path);
  return path;
}
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args], { cwd });

test.each(["non-repository", "missing-checkout", "non-git-ancestor"] as const)(
  "unverified %s receipts retain unrelated work across restart",
  async (kind) => {
    const root = await directory();
    const repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(join(repo, "keep.txt"), "Committed work");
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "initial");
    const provider = fauxProvider({
      provider: "git-store-test",
      models: [{ id: "one" }],
      tokensPerSecond: 10000,
    });
    const titles = fauxProvider({
      provider: "git-store-test",
      models: [{ id: "one" }],
      tokensPerSecond: 10000,
    });
    const models = createModels();
    models.setProvider({
      ...provider.provider,
      streamSimple: (model, context, options) =>
        options?.sessionId?.endsWith(":title")
          ? titles.provider.streamSimple(model, context, options)
          : provider.provider.streamSimple(model, context, options),
    });
    const open = async () => {
      const core = await createCore({
        dataRoot: join(root, "data"),
        home: root,
        models,
        settings: {
          read: Effect.succeed({ agentMode: "standard", defaultThinkingLevel: "off" }),
          subscribe: () => () => {},
        },
        environment: { userAgent: "eta-test", shutdown: "preserve" },
      });
      clients.push(core);
      return core;
    };
    const core = await open();
    const project = await core.registerProject(repo);
    const base = (await core.workspaces(project.id))[0]!;
    const thread = await core.createThread(base.id);
    const input = {
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "new" as const, name: "managed" },
      requestId: "managed-request",
    };
    const managed = await core.createWorktree(input);
    expect((await core.openThread(thread.id)).id).toBe(thread.id);
    const unverifiedPath = kind === "non-git-ancestor" ? root : join(root, "unverified");
    if (kind === "non-repository") await mkdir(unverifiedPath);
    else if (kind === "missing-checkout")
      await git(repo, "worktree", "add", "-q", "-b", "external", unverifiedPath);
    const unverified = await core.registerWorkspace(project.id, unverifiedPath);
    if (kind === "missing-checkout") await git(repo, "worktree", "remove", unverifiedPath);
    const receipts = await core.reconcileWorktrees(project.id);
    expect(receipts.find((value) => value.workspaceId === unverified.id)).toMatchObject({
      managed: false,
      status: "needs_reconciliation",
    });
    expect(receipts.find((value) => value.workspaceId === managed.workspaceId)).toMatchObject({
      managed: true,
      status: "ready",
    });
    await expect(core.createThread(unverified.id)).rejects.toMatchObject({
      code: "WorkspaceUnavailable",
    });
    await expect(core.removeWorktree(unverified.id, "reject-unmanaged")).rejects.toMatchObject({
      code: "InvalidInput",
    });
    provider.setResponses([fauxAssistantMessage("Still available")]);
    const accepted = await core.submit(thread.id, "Continue normal work", "normal-input");
    await expect
      .poll(async () => (await core.operation(thread.id, accepted.operationId)).status, {
        timeout: 10_000,
      })
      .toBe("completed");
    const path = join(root, "data", "git.json");
    const disk = await readFile(path, "utf8");
    expect(JSON.parse(disk).worktrees["adopted:" + unverified.id]).toMatchObject({
      commonDir: "",
      managed: false,
      status: "needs_reconciliation",
    });
    await core.close();
    const reopened = await open();
    expect(
      (await reopened.openThread(thread.id)).snapshot.transcript.some(
        ({ message }) => message.role === "user",
      ),
    ).toBe(true);
    expect(
      (await reopened.listWorktrees(project.id)).find(
        (value) => value.workspaceId === unverified.id,
      )?.status,
    ).toBe("needs_reconciliation");
    expect((await reopened.createWorktree(input)).workspaceId).toBe(managed.workspaceId);
    expect(await readFile(path, "utf8")).toBe(disk);
  },
  30_000,
);

function receipt(): WorktreeReceipt {
  return {
    projectId: "project",
    requestId: "request",
    path: "/checkout",
    prefix: "",
    commonDir: "",
    branch: "main",
    createdBranch: false,
    baseSha: "known",
    managed: true,
    status: "ready",
    createdAt: 0,
  };
}

test.each([
  [true, "creating"],
  [true, "ready"],
  [true, "removing"],
  [true, "removed"],
  [true, "needs_reconciliation"],
  [false, "creating"],
  [false, "ready"],
  [false, "removing"],
  [false, "removed"],
] as const)("empty Git identity remains invalid: managed=%s status=%s", (managed, status) => {
  expect(() =>
    Schema.decodeUnknownSync(WorktreeReceiptSchema)({ ...receipt(), managed, status }),
  ).toThrow();
});

test("invalid Git writes leave the prior durable state and queue usable", async () => {
  const root = await directory();
  const runtime = ManagedRuntime.make(
    GitStoreService.layer.pipe(Layer.provide(AppPathsService.layer(root))),
  );
  try {
    const store = await runtime.runPromise(GitStoreService);
    await runtime.runPromise(
      store.update((state) => ({ ...state, requests: { keep: "original" } })),
    );
    const path = join(root, "git.json");
    const before = await readFile(path, "utf8");
    await expect(
      runtime.runPromise(
        store.update((state) => ({ ...state, worktrees: { invalid: receipt() } })),
      ),
    ).rejects.toMatchObject({ code: "InvalidInput" });
    expect(await readFile(path, "utf8")).toBe(before);
    await runtime.runPromise(
      store.update((state) => ({ ...state, requests: { ...state.requests, next: "accepted" } })),
    );
    expect((await runtime.runPromise(store.read)).requests).toEqual({
      keep: "original",
      next: "accepted",
    });
    // Malformed managed receipts already on disk remain rejected, never silently reset.
    const malformed = JSON.stringify({
      version: 1,
      projects: {},
      worktrees: { invalid: receipt() },
    });
    await writeFile(path, malformed);
    await expect(runtime.runPromise(store.read)).rejects.toMatchObject({ code: "StorageCorrupt" });
    await expect(runtime.runPromise(store.update((state) => state))).rejects.toMatchObject({
      code: "StorageCorrupt",
    });
    expect(await readFile(path, "utf8")).toBe(malformed);
  } finally {
    await runtime.dispose();
  }
});
