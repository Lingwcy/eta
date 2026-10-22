import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore, type CoreClient } from "../src/client.ts";
import type { CoreEnvironment } from "../src/service/environment.ts";
import { defineTask } from "@eta/agent";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(worktree: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "eta-lifecycle-"));
  directories.push(directory);
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const provider = fauxProvider({ provider: "lifecycle-test", models: [{ id: "one" }] });
  const models = createModels();
  let calls = 0;
  let started = false;
  const response = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const titles = fauxProvider({ provider: "lifecycle-test", models: [{ id: "one" }] });
  titles.setResponses([fauxAssistantMessage("Title")]);
  provider.setResponses([
    (_context, options) => {
      calls++;
      started = true;
      options?.signal?.addEventListener(
        "abort",
        () => response.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      return response.promise;
    },
  ]);
  models.setProvider({
    ...provider.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? titles.provider.streamSimple(model, context, options)
        : provider.provider.streamSimple(model, context, options),
  });
  const open = async (environment: Partial<CoreEnvironment> = {}) => {
    const core = await createCore({
      dataRoot: join(directory, "data"),
      home: directory,
      models,
      settings: {
        read: Effect.succeed({ agentMode: "standard", defaultThinkingLevel: "off" }),
        subscribe: () => () => {},
      },
      environment: { userAgent: "eta-core-test", shutdown: "preserve", ...environment },
    });
    clients.push(core);
    return core;
  };
  const core = await open();
  let workspaceId: string | null = null;
  if (worktree) {
    await writeFile(join(cwd, "keep.txt"), "Keep work");
    const git = promisify(execFile);
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "."],
      ["commit", "-q", "-m", "initial"],
    ]) {
      await git("git", [
        "-C",
        cwd,
        "-c",
        "user.name=Eta",
        "-c",
        "user.email=eta@example.com",
        ...args,
      ]);
    }
    const project = await core.registerProject(cwd);
    const base = (await core.workspaces(project.id))[0]!;
    const created = await core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "new", name: "lifecycle" },
      requestId: "worktree-create",
    });
    workspaceId = created.workspaceId!;
  }
  const thread = await core.createThread(workspaceId);
  const workspace = (await core.workspaces()).find((value) => value.id === thread.workspaceId)!;
  const file = join(workspace.cwd, "keep.txt");
  if (!worktree) await writeFile(file, "Keep work");
  return {
    core,
    open,
    thread,
    workspace,
    file,
    response,
    started: () => started,
    calls: () => calls,
  };
}

test.each([
  ["delete", false],
  ["delete", true],
  ["archive", false],
  ["archive", true],
  ["worktree", false],
  ["worktree", true],
] as const)(
  "persisted work blocks %s before and after opening history (warm=%s)",
  async (action, warm) => {
    const state = await fixture(action === "worktree");
    try {
      const admission = await state.core.submit(
        state.thread.id,
        "Keep unfinished work",
        "interrupted-input",
      );
      await expect.poll(state.started, { timeout: 10_000 }).toBe(true);
      await state.core.close();
      const restored = await state.open();
      if (warm) expect((await restored.recovery(state.thread.id)).required).toBe(true);
      const mutate = () =>
        action === "delete"
          ? restored.deleteThread(state.thread.id)
          : action === "archive"
            ? restored.archiveThread(state.thread.id, true)
            : restored.removeWorktree(state.workspace.id, "worktree-remove");
      let failure: unknown;
      try {
        await mutate();
      } catch (error) {
        failure = error;
      }
      const content = await readFile(state.file, "utf8").catch(() => undefined);
      const metadata = (await restored.threads(undefined, true)).find(
        (value) => value.id === state.thread.id,
      );
      expect({
        failure,
        content,
        id: metadata?.id,
        archivedAt: metadata?.archivedAt,
      }).toMatchObject({
        failure: { code: "Busy" },
        content: "Keep work",
        id: state.thread.id,
        archivedAt: undefined,
      });
      expect(state.calls()).toBe(1);
      expect((await restored.operation(state.thread.id, admission.operationId)).status).toBe(
        "paused",
      );
      await restored.stop(state.thread.id);
      await mutate();
      if (action !== "archive")
        await expect(readFile(state.file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      state.response.resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
    }
  },
  45_000,
);

test.each(["delete", "archive", "worktree"] as const)(
  "idle cold histories still allow %s",
  async (action) => {
    const state = await fixture(action === "worktree");
    await state.core.close();
    const restored = await state.open();
    if (action === "delete") await restored.deleteThread(state.thread.id);
    else if (action === "archive") await restored.archiveThread(state.thread.id, true);
    else await restored.removeWorktree(state.workspace.id, "idle-remove");
    expect(state.calls()).toBe(0);
    if (action !== "archive")
      await expect(readFile(state.file)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(state.file, "utf8")).toBe("Keep work");
  },
  30_000,
);

test("cold guards retain a background host task without a user submission or current definition", async () => {
  const state = await fixture(false);
  await state.core.close();
  let started = false;
  const task = defineTask<Record<string, never>, { phase: "hold" }, string>({
    name: "test.lifecycle-host",
    version: 1,
    initial: () => ({ phase: "hold" }),
    phases: {
      hold: async (_task, runtime) => {
        started = true;
        await new Promise<void>((resolve) =>
          runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        runtime.signal.throwIfAborted();
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const environment = { extensions: () => [{ name: "lifecycle-host", tasks: [task] }] };
  const original = await state.open(environment);
  await original.enqueueTask(state.thread.id, task.definition.name, {}, "host-request");
  await expect.poll(() => started, { timeout: 10_000 }).toBe(true);
  await original.close();
  const missing = await state.open();
  await expect(missing.archiveThread(state.thread.id, true)).rejects.toMatchObject({
    code: "Busy",
  });
  expect(await readFile(state.file, "utf8")).toBe("Keep work");
  expect(state.calls()).toBe(0);
  await missing.close();
  const restored = await state.open(environment);
  await restored.stop(state.thread.id);
  await restored.archiveThread(state.thread.id, true);
}, 30_000);
