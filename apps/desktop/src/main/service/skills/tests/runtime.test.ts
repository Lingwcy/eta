import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { CompactionEntry } from "@eta/agent";
import { ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { commandReply, dispatchCommand } from "../../../ipc.ts";
import type { DesktopApplication } from "../../../bootstrap.ts";
import { desktopServices } from "../../layer.ts";
import { ModelCatalogService } from "../../models/index.ts";
import { ProjectService } from "../../projects/index.ts";
import { WorkspaceService } from "../../workspaces/index.ts";
import { ThreadService } from "../../threads/index.ts";
import { RuntimeRegistryService } from "../../runtime/index.ts";
import { DesktopSettingsService } from "../../settings/index.ts";
import { SkillsService } from "../index.ts";
import { SkillsDoc } from "../extension.ts";

const directories: string[] = [];
const runtimes: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eta-skills-runtime-"));
  directories.push(directory);
  const cwd = join(directory, "project");
  const skillRoot = join(cwd, ".agents", "skills", "review");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  const skillPath = join(skillRoot, "SKILL.md");
  await writeFile(
    skillPath,
    "---\nname: review\ndescription: Review implementation changes\n---\nPINNED_REVIEW_INSTRUCTIONS. Consult references/guide.md only when needed.",
  );
  await writeFile(join(skillRoot, "references", "guide.md"), "LAZY_REFERENCE_CONTENT");
  const provider = fauxProvider({
    provider: "eta-skills",
    models: [{ id: "one" }],
    tokensPerSecond: 1000,
  });
  const title = fauxProvider({
    provider: "eta-skills",
    models: provider.models,
    tokensPerSecond: 1000,
  });
  const models = createModels();
  models.setProvider({
    ...provider.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? title.provider.streamSimple(model, context, options)
        : provider.provider.streamSimple(model, context, options),
  });
  const reopen = () => {
    const runtime = ManagedRuntime.make(
      desktopServices(
        join(directory, "data"),
        ModelCatalogService.layerWith(models),
        undefined,
        SkillsService.layerWith(directory),
      ),
    );
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = reopen();
  const projects = await runtime.runPromise(ProjectService);
  const project = await runtime.runPromise(projects.register({ rootPath: cwd }));
  const workspaces = await runtime.runPromise(WorkspaceService);
  const workspace = (await runtime.runPromise(workspaces.list(project.id)))[0]!;
  const threads = await runtime.runPromise(ThreadService);
  const settings = await runtime.runPromise(DesktopSettingsService);
  const registry = await runtime.runPromise(RuntimeRegistryService);
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const submit = async (prompt: string) => {
    await runtime.runPromise(threads.submit(created.id, prompt));
    await record.harness.waitForIdle(BACKGROUND_CONTEXT);
    await expect.poll(() => record.running).toBe(false);
    expect((await runtime.runPromise(threads.open(created.id))).snapshot.lastResult?.status).toBe(
      "completed",
    );
  };
  return {
    directory,
    cwd,
    skillRoot,
    skillPath,
    runtime,
    reopen,
    threads,
    settings,
    provider,
    created,
    record,
    submit,
  };
}

test("the provider discovers metadata, activates instructions, and reads supporting files in separate stages", async () => {
  const { provider, skillRoot, submit, runtime, threads, created, record } = await setup();
  provider.setResponses([
    (context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt).toContain("Review implementation changes");
      expect(prompt).not.toContain("PINNED_REVIEW_INSTRUCTIONS");
      expect(JSON.stringify(context.messages)).not.toContain("LAZY_REFERENCE_CONTENT");
      expect(getCurrentTools(context.messages).some((tool) => tool.name === "load_skill")).toBe(
        true,
      );
      return fauxAssistantMessage(fauxToolCall("load_skill", { name: "review" }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("PINNED_REVIEW_INSTRUCTIONS");
      expect(JSON.stringify(context.messages)).not.toContain("LAZY_REFERENCE_CONTENT");
      return fauxAssistantMessage(
        fauxToolCall("read", { path: join(skillRoot, "references", "guide.md") }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("LAZY_REFERENCE_CONTENT");
      return fauxAssistantMessage("Reviewed");
    },
  ]);
  await submit("Review the implementation");
  expect(
    (await record.harness.snapshot(SkillsDoc, record.conversation.id, BACKGROUND_CONTEXT))?.active,
  ).toHaveLength(1);
  const opened = await runtime.runPromise(threads.open(created.id));
  expect(opened.snapshot.activeSkills?.[0]).toMatchObject({
    name: "review",
    directory: await realpath(skillRoot),
  });
  expect(JSON.stringify(opened.snapshot.activeSkills)).not.toContain("PINNED_REVIEW_INSTRUCTIONS");
});

test("explicit skill selection is loaded before the first request and repeated activation keeps the pinned version", async () => {
  const { provider, skillPath, submit, record } = await setup();
  provider.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("PINNED_REVIEW_INSTRUCTIONS");
      return fauxAssistantMessage(fauxToolCall("load_skill", { name: "review" }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("Reviewed"),
    (context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt).toContain("PINNED_REVIEW_INSTRUCTIONS");
      expect(prompt).not.toContain("UPDATED_INSTRUCTIONS");
      return fauxAssistantMessage("Pinned");
    },
  ]);
  await submit("Use $review to check the patch");
  await writeFile(
    skillPath,
    (await readFile(skillPath, "utf8")).replace(
      "PINNED_REVIEW_INSTRUCTIONS",
      "UPDATED_INSTRUCTIONS",
    ),
  );
  await submit("Use $review again");
  expect(
    (await record.harness.snapshot(SkillsDoc, record.conversation.id, BACKGROUND_CONTEXT))?.active,
  ).toHaveLength(1);
});

test("skill state survives restart and context compaction without copying instructions into user messages", async () => {
  const { provider, submit, runtime, reopen, threads, created, record } = await setup();
  provider.setResponses([fauxAssistantMessage("First"), fauxAssistantMessage("Second")]);
  await submit("Use $review");
  await submit("Keep working");
  const entries = (
    await record.conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT)
  ).items.toReversed();
  const lastUser = entries
    .filter((entry) => entry.model?.some((message) => message.role === "user"))
    .at(-1)!;
  await record.conversation.commit(
    (tx) =>
      tx.appendEntry(record.conversation.id, {
        kind: CompactionEntry.kind,
        head: lastUser.id,
        model: [{ role: "user", content: "A compact summary", timestamp: 1 }],
      }),
    BACKGROUND_CONTEXT,
  );
  const history = await runtime.runPromise(threads.open(created.id));
  expect(
    history.snapshot.transcript
      .filter(({ message }) => message.role === "user")
      .some(({ message }) =>
        JSON.stringify(message.content).includes("PINNED_REVIEW_INSTRUCTIONS"),
      ),
  ).toBe(false);
  await runtime.dispose();
  const next = reopen();
  const nextThreads = await next.runPromise(ThreadService);
  const nextRegistry = await next.runPromise(RuntimeRegistryService);
  const nextRecord = await next.runPromise(nextRegistry.acquire(created.thread.sessionRef));
  provider.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("PINNED_REVIEW_INSTRUCTIONS");
      return fauxAssistantMessage("Restored");
    },
  ]);
  await next.runPromise(nextThreads.submit(created.id, "Continue after restart"));
  await nextRecord.harness.waitForIdle(BACKGROUND_CONTEXT);
  await expect.poll(() => nextRecord.running).toBe(false);
  expect((await next.runPromise(nextThreads.open(created.id))).snapshot.lastResult?.status).toBe(
    "completed",
  );
  expect((await next.runPromise(nextThreads.open(created.id))).snapshot.activeSkills).toHaveLength(
    1,
  );
});

test("disable and reenable take effect on later requests; removing an active skill allows its updated body to load", async () => {
  const { provider, submit, runtime, settings, threads, created, skillPath } = await setup();
  const expectInstructions = (
    messages: Parameters<typeof getCurrentSystemPrompt>[0],
    present: boolean,
  ) => {
    const prompt = getCurrentSystemPrompt(messages);
    expect(prompt.includes("PINNED_REVIEW_INSTRUCTIONS")).toBe(present);
    return fauxAssistantMessage("Done");
  };
  provider.setResponses([(context) => expectInstructions(context.messages, true)]);
  await submit("Use $review");
  const skills = await runtime.runPromise(SkillsService);
  const metadata = (
    await runtime.runPromise(skills.catalog(created.thread.sessionRef.metadata.cwd))
  ).skills[0]!;
  await runtime.runPromise(settings.update({ disabledSkills: [metadata.id] }));
  provider.setResponses([(context) => expectInstructions(context.messages, false)]);
  await submit("Continue without skills");
  await runtime.runPromise(settings.update({ disabledSkills: [] }));
  provider.setResponses([(context) => expectInstructions(context.messages, true)]);
  await submit("Continue with skills");
  await dispatchCommand(
    {
      unloadSkill: (id, name) => runtime.runPromise(threads.unloadSkill(id, name)),
    } as DesktopApplication,
    { type: "unload-skill", id: created.id, name: "review" },
  );
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.activeSkills).toEqual([]);
  await writeFile(
    skillPath,
    (await readFile(skillPath, "utf8")).replace(
      "PINNED_REVIEW_INSTRUCTIONS",
      "UPDATED_INSTRUCTIONS",
    ),
  );
  provider.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("UPDATED_INSTRUCTIONS");
      return fauxAssistantMessage("Updated");
    },
  ]);
  await submit("Use $review again");
});

test("project catalogs do not leak across workspaces and skill settings survive restart", async () => {
  const { directory, cwd, runtime, settings, reopen } = await setup();
  const service = await runtime.runPromise(SkillsService);
  const other = join(directory, "other-project");
  await mkdir(other);
  expect((await runtime.runPromise(service.catalog(other))).skills).toEqual([]);
  await runtime.runPromise(
    settings.update({ skillDirectories: [join(cwd, ".agents", "skills")], skillsEnabled: false }),
  );
  await runtime.dispose();
  const next = reopen();
  const nextSettings = await next.runPromise(DesktopSettingsService);
  expect(await next.runPromise(nextSettings.read)).toMatchObject({
    skillDirectories: [join(cwd, ".agents", "skills")],
    skillsEnabled: false,
  });
});

test("settings expose all directory sources, and opening missing directories creates them", async () => {
  const { runtime, settings, directory, created } = await setup();
  const service = await runtime.runPromise(SkillsService);
  const cwd = created.thread.sessionRef.metadata.cwd;
  await runtime.runPromise(settings.update({ skillDirectories: ["~/custom-skills"] }));
  const catalog = await runtime.runPromise(service.catalog(cwd));
  expect(catalog.directories).toEqual([
    { path: join(directory, ".agents", "skills"), source: "user" },
    {
      path: join(directory, "custom-skills"),
      source: "custom",
      configuredPaths: ["~/custom-skills"],
    },
    { path: join(cwd, ".agents", "skills"), source: "project" },
  ]);
  const opened: string[] = [];
  const application = {
    openSkillsDirectory: async (path: string, cwd?: string) => {
      opened.push(await runtime.runPromise(service.prepareDirectory(path, cwd)));
    },
  } as DesktopApplication;
  for (const { path } of catalog.directories) {
    await dispatchCommand(application, { type: "open-skills-directory", path, cwd });
    expect((await stat(path)).isDirectory()).toBe(true);
  }
  expect(opened).toEqual(catalog.directories.map(({ path }) => path));
});

test("deduplicated project directories retain every custom configuration so it can be removed", async () => {
  const { runtime, settings, created } = await setup();
  const service = await runtime.runPromise(SkillsService);
  const cwd = created.thread.sessionRef.metadata.cwd;
  const path = join(cwd, ".agents", "skills");
  await runtime.runPromise(settings.update({ skillDirectories: [path, `${path}/`] }));
  const catalog = await runtime.runPromise(service.catalog(cwd));
  expect(catalog.directories).toHaveLength(2);
  expect(catalog.directories.find((directory) => directory.path === path)).toEqual({
    path,
    source: "project",
    configuredPaths: [path, `${path}/`],
  });
});

test("removed directories cannot be created and a file occupying a configured path reports an error", async () => {
  const { runtime, settings, directory } = await setup();
  const service = await runtime.runPromise(SkillsService);
  const path = join(directory, "removed");
  await runtime.runPromise(settings.update({ skillDirectories: [path] }));
  await runtime.runPromise(settings.update({ skillDirectories: [] }));
  await expect(runtime.runPromise(service.prepareDirectory(path))).rejects.toThrow(
    "不在当前技能目录中",
  );
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(path, "Keep this file");
  await runtime.runPromise(settings.update({ skillDirectories: [path] }));
  const reply = await commandReply(() => runtime.runPromise(service.prepareDirectory(path)));
  expect(reply).toMatchObject({
    ok: false,
    error: { code: "StorageUnavailable", message: "无法创建技能目录，请检查路径和访问权限" },
  });
  expect(await readFile(path, "utf8")).toBe("Keep this file");
});

test("a disabled skill cannot activate and a disabled tool is not restored by loading a skill", async () => {
  const { runtime, settings, provider, submit, record } = await setup();
  await runtime.runPromise(settings.update({ disabledTools: ["read", "bash"] }));
  provider.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("PINNED_REVIEW_INSTRUCTIONS");
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain("read");
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain("bash");
      return fauxAssistantMessage("No permissions added");
    },
  ]);
  await submit("Use $review");
  await runtime.runPromise(settings.update({ skillsEnabled: false }));
  await expect(submit("Use $review again")).rejects.toThrow();
  expect(record.running).toBe(false);
});

test.each(["missing", "review"])(
  "failed activation of %s reports a tool error without saving partial skill state",
  async (name) => {
    const { runtime, threads, created, provider, submit, skillPath } = await setup();
    if (name === "review") {
      await writeFile(skillPath, "---\nname: review\ndescription: Empty skill\n---\n");
    }
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("load_skill", { name }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Unable to activate the skill"),
    ]);
    await submit("Try loading the skill");
    const opened = await runtime.runPromise(threads.open(created.id));
    expect(opened.snapshot.activeSkills).toEqual([]);
    expect(
      opened.snapshot.transcript.find(({ message }) => message.role === "toolResult")?.message,
    ).toMatchObject({ isError: true });
  },
);

test("active skills cannot be removed during a running request", async () => {
  const { runtime, threads, created, record, provider } = await setup();
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  provider.setResponses([
    (_context, options) => {
      ready.resolve();
      options?.signal?.addEventListener(
        "abort",
        () => answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      return answer.promise;
    },
  ]);
  await runtime.runPromise(threads.submit(created.id, "Use $review"));
  await ready.promise;
  try {
    await expect(runtime.runPromise(threads.unloadSkill(created.id, "review"))).rejects.toThrow(
      "请先停止或完成当前任务",
    );
    expect((await runtime.runPromise(threads.open(created.id))).snapshot.activeSkills).toHaveLength(
      1,
    );
  } finally {
    answer.resolve(fauxAssistantMessage("Done"));
    await record.harness.waitForIdle(BACKGROUND_CONTEXT);
    await expect.poll(() => record.running).toBe(false);
  }
  await runtime.runPromise(threads.unloadSkill(created.id, "review"));
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.activeSkills).toEqual([]);
});
