import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createCore, type CoreClient } from "../src/client.ts";

type ReadFile = (typeof import("node:fs/promises"))["readFile"];
const io = vi.hoisted(() => ({
  readFile: vi.fn<(...args: Parameters<ReadFile>) => ReturnType<ReadFile>>(),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  io.readFile.mockImplementation(fs.readFile);
  return { ...fs, readFile: io.readFile };
});
const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  io.readFile.mockImplementation(fs.readFile);
  for (const core of clients.splice(0)) await core.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-worktree-admission-"));
  directories.push(directory);
  const cwd = join(directory, "repo");
  await mkdir(cwd);
  await writeFile(join(cwd, "keep.txt"), "Kept branch");
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
  const provider = fauxProvider({
    provider: "admission-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "admission-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  let executions = 0;
  provider.setResponses([
    () => {
      executions++;
      return fauxAssistantMessage("Complete");
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
  const core = await createCore({
    dataRoot: join(directory, "data"),
    home: directory,
    models,
    settings: {
      read: Effect.succeed({ agentMode: "standard", defaultThinkingLevel: "off" }),
      subscribe: () => () => {},
    },
    environment: { userAgent: "eta-core-test" },
  });
  clients.push(core);
  const project = await core.registerProject(cwd);
  const base = (await core.workspaces(project.id))[0]!;
  const create = (name: string) =>
    core.createWorktree({
      projectId: project.id,
      baseWorkspaceId: base.id,
      branch: { kind: "new", name },
      requestId: name,
    });
  const target = await create("target");
  const other = await create("other");
  const thread = await core.createThread(target.workspaceId!);
  return { core, target, other, thread, directory, executions: () => executions };
}

test.each(["target", "other", "refused", "read-error"] as const)(
  "an admission awaiting its final Git read observes %s removal",
  async (kind) => {
    const state = await fixture();
    if (kind === "refused") await writeFile(join(state.target.cwd, "dirty.txt"), "Unsaved");
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const held = Promise.withResolvers<void>();
    let entered = false;
    let reads = 0;
    io.readFile.mockImplementation(async (...args) => {
      const result = await fs.readFile(...args);
      // validate, ready, then the final claim; retain the actual old on-disk read result.
      if (String(args[0]) === join(state.directory, "data", "git.json") && ++reads === 3) {
        entered = true;
        await held.promise;
        if (kind === "read-error") throw new Error("Controlled Git read failure");
      }
      return result;
    });
    const submission = state.core.submit(state.thread.id, "Run after validation", "held-admission");
    const result = submission.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      await expect.poll(() => entered, { timeout: 10_000 }).toBe(true);
      expect(state.executions()).toBe(0);
      if (kind === "read-error") {
        held.resolve();
        const outcome = await result;
        expect(outcome.error).toMatchObject({ code: "StorageUnavailable" });
        expect(outcome.value).toBeUndefined();
        expect(
          await state.core.operationByRequest(state.thread.id, "held-admission"),
        ).toBeUndefined();
        expect(state.executions()).toBe(0);
        const retry = await state.core.submit(
          state.thread.id,
          "Retry after failed validation",
          "held-admission",
        );
        await expect
          .poll(
            async () => (await state.core.operation(state.thread.id, retry.operationId)).status,
            { timeout: 10_000 },
          )
          .toBe("completed");
        expect(state.executions()).toBe(1);
        expect(
          (await state.core.openThread(state.thread.id)).snapshot.transcript.filter(
            ({ message }) => message.role === "user",
          ),
        ).toHaveLength(1);
        await expect
          .poll(
            async () => {
              try {
                return (
                  await state.core.removeWorktree(state.target.workspaceId!, "after-rejection")
                ).status;
              } catch (error) {
                if (error && typeof error === "object" && "code" in error && error.code === "Busy")
                  return "busy";
                throw error;
              }
            },
            { timeout: 10_000 },
          )
          .toBe("removed");
        return;
      }
      const selected = kind === "other" ? state.other : state.target;
      const removing = await state.core
        .removeWorktree(selected.workspaceId!, "remove-selected")
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
      if (removing.value) {
        expect(removing.value.status).toBe("removed");
        await expect(readFile(join(selected.cwd, "keep.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      held.resolve();
      const outcome = await result;
      if (outcome.value) {
        await expect
          .poll(
            async () =>
              (await state.core.operation(state.thread.id, outcome.value!.operationId)).status,
            { timeout: 10_000 },
          )
          .toBe("completed");
        expect(state.executions()).toBe(1);
      }
      if (kind === "target" && removing.value) {
        expect(outcome.error).toMatchObject({ code: "WorkspaceUnavailable" });
        expect(outcome.value).toBeUndefined();
        expect(
          await state.core.operationByRequest(state.thread.id, "held-admission"),
        ).toBeUndefined();
        expect(state.executions()).toBe(0);
      } else {
        if (kind === "other") expect(removing.value?.status).toBe("removed");
        else
          expect(removing.error).toMatchObject({
            code: kind === "target" ? "Busy" : expect.stringMatching(/^(Busy|InvalidInput)$/),
          });
        expect(outcome.error).toBeUndefined();
        expect(outcome.value).toBeDefined();
        expect(await readFile(join(state.target.cwd, "keep.txt"), "utf8")).toBe("Kept branch");
      }
    } finally {
      held.resolve();
      await result;
    }
  },
  30_000,
);
