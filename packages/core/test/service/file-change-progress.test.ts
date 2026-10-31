import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FileChangeReference } from "@eta/agent/tools";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { testServices } from "../support/runtime.ts";
import { ProjectService } from "../../src/service/projects/index.ts";
import { WorkspaceService } from "../../src/service/workspaces/index.ts";
import { ThreadService } from "../../src/service/threads/index.ts";
import { FileChangeService } from "../../src/service/file-changes/index.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each(
  ["write", "edit"].flatMap((tool) =>
    ["healthy", "prepare-progress", "complete-progress"].map((mode) => ({ tool, mode })),
  ),
)(
  "$tool retains durable history after $mode",
  async ({ tool, mode }) => {
    const directory = await mkdtemp(join(tmpdir(), "eta-file-change-progress-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const cwd = join(directory, "project");
    await mkdir(cwd);
    const provider = fauxProvider({
      provider: "progress-test",
      models: [{ id: "one" }],
      tokensPerSecond: 10000,
    });
    const titles = fauxProvider({
      provider: "progress-test",
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
    const runtime = ManagedRuntime.make(
      testServices(join(directory, "data"), models, undefined, directory),
    );
    cleanups.push(() => runtime.dispose());
    const threads = await runtime.runPromise(ThreadService);
    const changes = await runtime.runPromise(FileChangeService);
    const recorder = changes.recorder.bind(changes);
    const captured: FileChangeReference[] = [];
    let declaredFailure = false;
    vi.spyOn(changes, "recorder").mockImplementation((ref) => {
      const record = recorder(ref);
      return async (...args) => {
        const capture = await record(...args);
        captured.push(capture.reference);
        if (mode !== "healthy") {
          const api = args[2];
          const details = api.details.bind(api);
          let publications = 0;
          vi.spyOn(api, "details").mockImplementation(async (...input) => {
            publications++;
            if (publications === (mode === "prepare-progress" ? 1 : 2)) {
              declaredFailure = true;
              throw new Error("Controlled progress publication failure");
            }
            return details(...input);
          });
        }
        return capture;
      };
    });
    const project = await runtime.runPromise(
      (await runtime.runPromise(ProjectService)).register({ rootPath: cwd }),
    );
    const workspace = (
      await runtime.runPromise((await runtime.runPromise(WorkspaceService)).list(project.id))
    )[0]!;
    const thread = await runtime.runPromise(
      threads.create(workspace.id, undefined, {
        provider: "progress-test",
        modelId: "one",
        thinkingLevel: "off",
        sandboxMode: "danger-full-access",
      }),
    );
    if (tool === "edit") await writeFile(join(cwd, "saved.txt"), "original\n");
    const call =
      tool === "write"
        ? fauxToolCall("write", { path: "saved.txt", content: "saved\n" })
        : fauxToolCall("edit", {
            path: "saved.txt",
            edits: [{ oldText: "original", newText: "saved" }],
          });
    provider.setResponses([
      fauxAssistantMessage(call, { stopReason: "toolUse" }),
      fauxAssistantMessage("Done"),
    ]);
    const admission = await runtime.runPromise(threads.submit(thread.thread.id, "Write the file"));
    await expect
      .poll(
        async () =>
          (await runtime.runPromise(threads.operation(thread.thread.id, admission.operationId)))
            .status,
        { timeout: 20000 },
      )
      .toBe("completed");
    expect(await readFile(join(cwd, "saved.txt"), "utf8")).toBe("saved\n");
    expect(captured).toHaveLength(1);
    expect(declaredFailure).toBe(mode !== "healthy");
    const input = { threadId: thread.thread.id, changeId: captured[0]!.id };
    const history = await runtime.runPromise(changes.fileChangeDiff(input));
    expect(history, JSON.stringify(history)).toMatchObject({
      status: "ready",
      path: "saved.txt",
      patch: expect.stringContaining("+saved"),
    });
    expect(JSON.stringify(await runtime.runPromise(threads.open(thread.thread.id)))).toContain(
      captured[0]!.id,
    );
    // The saved evidence does not depend on the current workspace file.
    await rm(join(cwd, "saved.txt"));
    expect(await runtime.runPromise(changes.fileChangeDiff(input))).toEqual(history);
  },
  30_000,
);
