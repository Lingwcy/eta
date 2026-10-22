import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createCore, type CoreClient } from "../src/client.ts";

const io = vi.hoisted(() => ({
  writeFile: vi.fn<(typeof import("node:fs/promises"))["writeFile"]>(),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  io.writeFile.mockImplementation(fs.writeFile);
  return { ...fs, writeFile: io.writeFile };
});
const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  io.writeFile.mockImplementation(fs.writeFile);
  for (const core of clients.splice(0)) await core.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const kinds = ["same", "child", "above-prefix", "beside-prefix"] as const;
type Kind = (typeof kinds)[number] | "lookalike";
async function fixture(kind: Kind, hold = false) {
  const directory = await mkdtemp(join(tmpdir(), "eta-worktree-scope-"));
  directories.push(directory);
  const root = join(directory, "repo");
  for (const name of ["", "app", "other"]) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "keep.txt"), "Tracked work");
  }
  const git = promisify(execFile);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    ["commit", "-q", "-m", "initial"],
  ])
    await git("git", [
      "-C",
      root,
      "-c",
      "user.name=Eta",
      "-c",
      "user.email=eta@example.com",
      ...args,
    ]);
  const provider = fauxProvider({
    provider: "scope-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "scope-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const response = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  let calls = 0;
  provider.setResponses([
    (_context, options) => {
      calls++;
      if (!hold) return fauxAssistantMessage("Complete");
      options?.signal?.addEventListener(
        "abort",
        () => response.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      return response.promise;
    },
  ]);
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
      dataRoot: join(directory, "data"),
      home: directory,
      models,
      settings: {
        read: Effect.succeed({ agentMode: "standard", defaultThinkingLevel: "off" }),
        subscribe: () => () => {},
      },
      environment: { userAgent: "eta-core-test", shutdown: "preserve" },
    });
    clients.push(core);
    return core;
  };
  const core = await open();
  const project = await core.registerProject(kind.endsWith("prefix") ? join(root, "app") : root);
  const base = (await core.workspaces(project.id))[0]!;
  const checkout = await core.createWorktree({
    projectId: project.id,
    baseWorkspaceId: base.id,
    branch: { kind: "new", name: "target" },
    requestId: "target",
  });
  const cwd =
    kind === "child"
      ? join(checkout.path, "app")
      : kind === "above-prefix"
        ? checkout.path
        : kind === "beside-prefix"
          ? join(checkout.path, "other")
          : kind === "lookalike"
            ? checkout.path + "-other"
            : checkout.cwd;
  if (kind === "lookalike") {
    await mkdir(cwd);
    await writeFile(join(cwd, "keep.txt"), "Tracked work");
  }
  const alias = await core.registerProject(cwd, "Alias");
  const workspace = (await core.workspaces(alias.id))[0]!;
  expect(workspace.id).not.toBe(checkout.workspaceId);
  const thread = await core.createThread(workspace.id);
  return {
    core,
    open,
    root,
    project,
    git,
    checkout,
    thread,
    cwd,
    directory,
    calls: () => calls,
    release: () => response.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
  };
}

for (const kind of kinds)
  test.each([false, true])(
    "active aliases prevent removal: " + kind + " cold=%s",
    async (cold) => {
      const state = await fixture(kind, true);
      try {
        const input = await state.core.submit(state.thread.id, "Keep working", "active-input");
        await expect.poll(state.calls, { timeout: 10_000 }).toBe(1);
        let core = state.core;
        if (cold) {
          await core.close();
          core = await state.open();
        }
        const failure = await core
          .removeWorktree(state.checkout.workspaceId!, "remove-active")
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        const content = await readFile(join(state.cwd, "keep.txt"), "utf8").catch(() => undefined);
        expect({ failure, content }).toMatchObject({
          failure: { code: "Busy" },
          content: "Tracked work",
        });
        expect((await core.operation(state.thread.id, input.operationId)).status).toBe(
          cold ? "paused" : "running",
        );
        await core.stop(state.thread.id);
        await expect
          .poll(
            async () => {
              try {
                return (await core.removeWorktree(state.checkout.workspaceId!, "after-stop"))
                  .status;
              } catch (error) {
                if (error && typeof error === "object" && "code" in error && error.code === "Busy")
                  return "busy";
                throw error;
              }
            },
            { timeout: 10_000 },
          )
          .toBe("removed");
        await expect(readFile(join(state.cwd, "keep.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        state.release();
      }
    },
    30_000,
  );

test.each(kinds)(
  "removing a checkout blocks a new alias admission: %s",
  async (kind) => {
    const state = await fixture(kind);
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const gate = Promise.withResolvers<void>();
    let entered = false;
    io.writeFile.mockImplementation(async (...args) => {
      await fs.writeFile(...args);
      if (
        String(args[0]).startsWith(join(state.directory, "data", "git.json") + ".") &&
        String(args[1]).includes('"status": "removing"')
      ) {
        entered = true;
        await gate.promise;
      }
    });
    const removal = state.core.removeWorktree(state.checkout.workspaceId!, "remove-idle");
    const finished = removal.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      await expect.poll(() => entered, { timeout: 10_000 }).toBe(true);
      const outcome = await state.core.submit(state.thread.id, "Do not enter", "racing-input").then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      if (outcome.value)
        await expect
          .poll(
            async () =>
              (await state.core.operation(state.thread.id, outcome.value!.operationId)).status,
            { timeout: 10_000 },
          )
          .toBe("completed");
      expect(outcome.error).toMatchObject({ code: "WorkspaceUnavailable" });
      expect(outcome.value).toBeUndefined();
      expect(state.calls()).toBe(0);
      expect(await state.core.operationByRequest(state.thread.id, "racing-input")).toBeUndefined();
    } finally {
      gate.resolve();
      await finished;
      state.release();
    }
    const removed = await finished;
    expect(removed.error).toBeUndefined();
    expect(removed.value?.status).toBe("removed");
  },
  30_000,
);

test.each([...kinds, "lookalike"] as const)(
  "removed checkout tombstones cover aliases but not pathname lookalikes: %s",
  async (kind) => {
    const state = await fixture(kind);
    await state.core.removeWorktree(state.checkout.workspaceId!, "remove-before-input");
    await mkdir(state.cwd, { recursive: true });
    await writeFile(join(state.cwd, "keep.txt"), "Replacement directory");
    const outcome = await state.core.submit(state.thread.id, "Check scope", "after-removal").then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    if (outcome.value)
      await expect
        .poll(
          async () =>
            (await state.core.operation(state.thread.id, outcome.value!.operationId)).status,
          { timeout: 10_000 },
        )
        .toBe("completed");
    if (kind === "lookalike") {
      expect(outcome.error).toBeUndefined();
      expect(state.calls()).toBe(1);
    } else {
      expect(outcome.error).toMatchObject({ code: "WorkspaceUnavailable" });
      expect(state.calls()).toBe(0);
    }
  },
  30_000,
);

test("idle aliases observe the removed checkout without reopening history", async () => {
  const state = await fixture("child");
  let views = 0;
  let blocked: string | undefined;
  const failures: string[] = [];
  const stop = await state.core.subscribe(
    state.thread.id,
    (value) => {
      views++;
      blocked = value.snapshot.blockedReason;
    },
    (message) => {
      failures.push(message);
    },
  );
  try {
    await expect.poll(() => views, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(blocked).toBeUndefined();
    await state.core.removeWorktree(state.checkout.workspaceId!, "remove-observed");
    await expect.poll(() => blocked, { timeout: 10_000 }).toContain("工作区已移除");
    expect(failures).toEqual([]);
  } finally {
    stop();
    state.release();
  }
}, 30_000);

test("unavailable alias work can still be cancelled and its history deleted", async () => {
  const state = await fixture("child", true);
  try {
    const input = await state.core.submit(state.thread.id, "Interrupted", "lost-checkout");
    await expect.poll(state.calls, { timeout: 10_000 }).toBe(1);
    await state.core.close();
    // External Git is outside Eta's exclusion contract; maintenance must still remain possible.
    await state.git("git", ["-C", state.root, "worktree", "remove", state.checkout.path]);
    const core = await state.open();
    expect(
      (await core.reconcileWorktrees(state.project.id)).find(
        (value) => value.workspaceId === state.checkout.workspaceId,
      )?.status,
    ).toBe("needs_reconciliation");
    await core.stop(state.thread.id);
    expect((await core.operation(state.thread.id, input.operationId)).status).toBe("aborted");
    expect(state.calls()).toBe(1);
    await core.deleteThread(state.thread.id);
    expect(
      (await core.threads(undefined, true)).some((value) => value.id === state.thread.id),
    ).toBe(false);
  } finally {
    state.release();
  }
}, 30_000);

test("unverified unmanaged ancestors do not block independent execution", async () => {
  const state = await fixture("lookalike");
  await state.git("git", ["-C", state.directory, "init", "-q"]);
  const unverified = await state.core.registerWorkspace(state.project.id, state.directory);
  expect(
    (await state.core.reconcileWorktrees(state.project.id)).find(
      (value) => value.workspaceId === unverified.id,
    )?.status,
  ).toBe("needs_reconciliation");
  const input = await state.core.submit(
    state.thread.id,
    "Independent from unverified metadata",
    "unverified-ancestor",
  );
  await expect
    .poll(async () => (await state.core.operation(state.thread.id, input.operationId)).status, {
      timeout: 10_000,
    })
    .toBe("completed");
  expect(state.calls()).toBe(1);
}, 30_000);

test("an active pathname lookalike does not block removal", async () => {
  const state = await fixture("lookalike", true);
  try {
    await state.core.submit(state.thread.id, "Independent work", "independent");
    await expect.poll(state.calls, { timeout: 10_000 }).toBe(1);
    expect(
      (await state.core.removeWorktree(state.checkout.workspaceId!, "remove-neighbor")).status,
    ).toBe("removed");
    expect(await readFile(join(state.cwd, "keep.txt"), "utf8")).toBe("Tracked work");
    await state.core.stop(state.thread.id);
  } finally {
    state.release();
  }
}, 30_000);
