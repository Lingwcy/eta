import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { ComputerService } from "@eta/computer-use/service";
import type { ComputerAdapter } from "@eta/computer-use/protocol";
import { expect, test } from "vite-plus/test";
import { commandReply, dispatchCommand } from "./ipc.ts";
import type { DesktopApplication } from "./bootstrap.ts";
import { setup } from "./tests/runtime-fixture.ts";
import { SkillsService } from "./service/skills/index.ts";
import { DesktopSettingsService } from "./service/settings/index.ts";
import { ThreadService } from "@eta/core/service/threads/index";

test("turning computer use off cancels an in-flight observation and allows a later grant", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const held = Promise.withResolvers<void>();
  const layout = { id: "one", revision: "one", bounds: { x: 0, y: 0, width: 100, height: 100 } };
  const capture = {
    width: 1,
    height: 1,
    layout,
    image: {
      type: "image" as const,
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
    },
  };
  let cleaned = 0;
  const adapter: ComputerAdapter = {
    layout: async () => layout,
    capture: async (signal) => {
      entered.resolve(signal);
      await held.promise;
      signal.throwIfAborted();
      return capture;
    },
    input: async () => {
      throw new Error("unexpected input");
    },
    releaseInputs: async () => {
      cleaned++;
    },
  };
  const f = await setup(true, { service: new ComputerService(adapter), enabled: () => true });
  await f.runtime.runPromise(f.settings.update({ agentMode: "standard", computerUse: true }));
  f.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("computer", { action: "screenshot" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Stopped observation"),
  ]);
  const admission = await f.runtime.runPromise(f.threads.submit(f.created.id, "Observe"));
  try {
    const signal = await entered.promise;
    await f.runtime.runPromise(f.settings.update({ computerUse: false }));
    await expect.poll(() => signal.aborted).toBe(true);
  } finally {
    held.resolve();
  }
  await expect
    .poll(
      async () =>
        (await f.runtime.runPromise(f.threads.operation(f.created.id, admission.operationId)))
          .status,
      { timeout: 15000 },
    )
    .toBe("completed");
  expect(cleaned).toBeGreaterThan(0);
  adapter.capture = async () => capture;
  await f.runtime.runPromise(f.settings.update({ computerUse: true }));
  f.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("computer", { action: "screenshot" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("New observation"),
  ]);
  const next = await f.runtime.runPromise(f.threads.submit(f.created.id, "Observe again"));
  await expect
    .poll(
      async () =>
        (await f.runtime.runPromise(f.threads.operation(f.created.id, next.operationId))).status,
      { timeout: 15000 },
    )
    .toBe("completed");
  const state = await f.runtime.runPromise(f.threads.open(f.created.id));
  expect(JSON.stringify(state)).toContain(capture.image.data);
});

test.each(["standard", "codemode"] as const)(
  "the persisted permissions switch controls the same %s chat and survives restart",
  async (mode) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=";
    const layout = {
      id: "primary",
      revision: "one",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    };
    let captures = 0;
    const service = new ComputerService({
      layout: async () => layout,
      capture: async () => {
        captures++;
        return {
          width: 1,
          height: 1,
          layout,
          image: { type: "image", mimeType: "image/png", data: png },
        };
      },
      input: async () => {},
      releaseInputs: async () => {},
    });
    const f = await setup(true, { service, enabled: () => true });
    const application = {
      updateSettings: (patch) => f.runtime.runPromise(f.settings.update(patch)),
    } satisfies Pick<DesktopApplication, "updateSettings">;
    await f.runtime.runPromise(f.settings.update({ agentMode: mode }));
    let checked = 0;
    let codeChecks = 0;
    const observe = () =>
      mode === "standard"
        ? fauxAssistantMessage(fauxToolCall("computer", { action: "screenshot" }), {
            stopReason: "toolUse",
          })
        : fauxAssistantMessage(
            fauxToolCall("codemode", {
              code: 'const r=await tools.computer({action:"screenshot"});if(!r.ok)throw Error(r.error.message);image(r.image);',
            }),
            { stopReason: "toolUse" },
          );
    const run = async (enabled: boolean) => {
      f.provider.setResponses([
        (context) => {
          if (mode === "standard")
            expect(getCurrentTools(context.messages).some((tool) => tool.name === "computer")).toBe(
              enabled,
            );
          checked++;
          if (mode === "codemode")
            return fauxAssistantMessage(
              fauxToolCall("codemode", {
                code: `if(ALL_TOOLS.some(t=>t.name==="computer")!==${enabled})throw Error("Incorrect computer availability");${enabled ? 'const r=await tools.computer({action:"screenshot"});if(!r.ok)throw Error(r.error.message);image(r.image);' : ""}text("Permission checked");`,
              }),
              { stopReason: "toolUse" },
            );
          return enabled ? observe() : fauxAssistantMessage("Disabled");
        },
        ...(mode === "codemode"
          ? [
              (context: TranscriptContext) => {
                const result = context.messages.findLast(
                  (message) => message.role === "toolResult",
                );
                expect(result?.role === "toolResult" && result.isError).toBe(false);
                codeChecks++;
                return fauxAssistantMessage("Observed");
              },
            ]
          : enabled
            ? [fauxAssistantMessage("Observed")]
            : []),
      ]);
      const admission = await f.runtime.runPromise(f.threads.submit(f.created.id, "Use desktop"));
      await expect
        .poll(
          async () =>
            (await f.runtime.runPromise(f.threads.operation(f.created.id, admission.operationId)))
              .status,
          { timeout: 15000 },
        )
        .toBe("completed");
    };
    await run(false);
    await dispatchCommand(application as DesktopApplication, {
      type: "settings",
      patch: { computerUse: true },
    });
    await run(true);
    await dispatchCommand(application as DesktopApplication, {
      type: "settings",
      patch: { computerUse: false },
    });
    await run(false);
    await dispatchCommand(application as DesktopApplication, {
      type: "settings",
      patch: { computerUse: true },
    });
    await run(true);
    expect(checked).toBe(4);
    if (mode === "codemode") expect(codeChecks).toBe(4);
    expect(captures).toBe(2);
    await f.runtime.dispose();
    const next = f.reopen();
    const preferences = await next.runPromise(DesktopSettingsService);
    expect((await next.runPromise(preferences.read)).computerUse).toBe(true);
    const threads = await next.runPromise(ThreadService);
    f.provider.setResponses([observe(), fauxAssistantMessage("Observed after restart")]);
    const admission = await next.runPromise(threads.submit(f.created.id, "Observe after restart"));
    await expect
      .poll(
        async () =>
          (await next.runPromise(threads.operation(f.created.id, admission.operationId))).status,
        { timeout: 15000 },
      )
      .toBe("completed");
    expect(captures).toBe(3);
  },
);

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

test("IPC reconciles an earlier local operation after a later turn replaces lastResult", async () => {
  const { runtime, threads, registry, provider, created } = await setup();
  provider.setResponses([
    fauxAssistantMessage("First answer"),
    fauxAssistantMessage("Later answer"),
  ]);
  const first = await runtime.runPromise(threads.submit(created.id, "First input", "first-input"));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await expect.poll(() => record.running, { timeout: 10000 }).toBe(false);
  const later = await runtime.runPromise(threads.submit(created.id, "Later input", "later-input"));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await expect.poll(() => record.running, { timeout: 10000 }).toBe(false);
  expect(
    (await runtime.runPromise(threads.open(created.id))).snapshot.lastResult?.operationId,
  ).toBe(later.operationId);
  const reply = await commandReply(() =>
    dispatchCommand(
      {
        operation: (id, operationId) => runtime.runPromise(threads.operation(id, operationId)),
      } as DesktopApplication,
      {
        type: "operation",
        id: created.id,
        operationId: first.operationId,
      },
    ),
  );
  expect(JSON.parse(JSON.stringify(reply))).toMatchObject({
    ok: true,
    value: { ...first, status: "completed" },
  });
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
