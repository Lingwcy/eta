import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vite-plus/test";
import { commandReply, dispatchCommand } from "./ipc.ts";
import type { DesktopApplication } from "./bootstrap.ts";
import { setup } from "./tests/runtime-fixture.ts";
import { SkillsService } from "./service/skills/index.ts";
import { DesktopSettingsService } from "./service/settings/index.ts";
import { ThreadService } from "@eta/core/service/threads/index";

test("persisted desktop skill preferences reach Core after reopening the service graph", async () => {
  const { runtime, settings, cwd, created, reopen } = await setup();
  const skillDirectories = [join(cwd, ".agents", "skills")];
  await runtime.runPromise(settings.update({ skillDirectories, skillsEnabled: false }));
  await runtime.dispose();
  const next = reopen();
  const preferences = await next.runPromise(DesktopSettingsService);
  expect(await next.runPromise(preferences.read)).toMatchObject({
    skillDirectories,
    skillsEnabled: false,
  });
  const threads = await next.runPromise(ThreadService);
  await expect(next.runPromise(threads.submit(created.id, "Use $review"))).rejects.toThrow();
  expect((await next.runPromise(threads.open(created.id))).snapshot.activeSkills).toEqual([]);
});

test("unloading an active skill through IPC updates the persisted thread state", async () => {
  const { runtime, threads, created, registry, provider } = await setup();
  provider.setResponses([fauxAssistantMessage("Reviewed")]);
  await runtime.runPromise(threads.submit(created.id, "Use $review"));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.harness.waitForIdle(BACKGROUND_CONTEXT);
  await expect.poll(() => record.running).toBe(false);
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.activeSkills).toHaveLength(
    1,
  );
  await dispatchCommand(
    {
      unloadSkill: (id, name) => runtime.runPromise(threads.unloadSkill(id, name)),
    } as DesktopApplication,
    { type: "unload-skill", id: created.id, name: "review" },
  );
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.activeSkills).toEqual([]);
});

test("a configured skills path occupied by a file reports the domain failure across IPC", async () => {
  const { runtime, settings, directory } = await setup();
  const service = await runtime.runPromise(SkillsService);
  const path = join(directory, "occupied");
  await writeFile(path, "Keep this file");
  await runtime.runPromise(settings.update({ skillDirectories: [path] }));
  const reply = await commandReply(() =>
    dispatchCommand(
      {
        openSkillsDirectory: async (path, cwd) => {
          await runtime.runPromise(service.prepareDirectory(path, cwd));
        },
      } as DesktopApplication,
      { type: "open-skills-directory", path },
    ),
  );
  expect(reply).toMatchObject({
    ok: false,
    error: { code: "StorageUnavailable", message: "无法创建技能目录，请检查路径和访问权限" },
  });
  expect(await readFile(path, "utf8")).toBe("Keep this file");
});

test("Electron submissions accept absent optional image fields and persist text and images", async () => {
  const { runtime, threads, registry, provider, workspace } = await setup(true);
  const created = await runtime.runPromise(threads.create(workspace.id));
  const application = {
    submit: (
      id: string,
      prompt: string,
      requestId?: string,
      images?: Parameters<typeof threads.submit>[3],
    ) => runtime.runPromise(threads.submit(id, prompt, requestId, images)),
  } as DesktopApplication;
  provider.setResponses([
    fauxAssistantMessage("First response"),
    fauxAssistantMessage("Image response"),
  ]);
  await dispatchCommand(
    application,
    structuredClone({
      type: "submit",
      id: created.id,
      prompt: "Plain text",
      requestId: "ipc-text",
      images: undefined,
    }),
  );
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect(
    (await runtime.runPromise(threads.open(created.id))).snapshot.transcript[0]?.message.content,
  ).toBe("Plain text");
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
  await dispatchCommand(
    application,
    structuredClone({
      type: "submit",
      id: created.id,
      prompt: "",
      requestId: "ipc-image",
      images: [{ type: "image", mimeType: "image/png", data, name: undefined, note: undefined }],
    }),
  );
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const users = (await runtime.runPromise(threads.open(created.id))).snapshot.transcript.filter(
    ({ message }) => message.role === "user",
  );
  expect(users).toHaveLength(2);
  expect(users[1]?.message.content).toEqual([{ type: "image", mimeType: "image/png", data }]);
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
