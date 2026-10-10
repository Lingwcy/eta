import { DraftThread } from "../../desktop/renderer/src/agent/draft-thread.ts";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createBotApplication } from "./application.ts";
import { DesktopBot, withBot } from "../../desktop/src/main/bot.ts";
import type { LocalDesktopApplication } from "../../desktop/src/main/bootstrap.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(defaultProvider?: string) {
  const root = await mkdtemp(join(tmpdir(), "eta-desktop-bot-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspaces", "cloud");
  await mkdir(cwd, { recursive: true });
  const dataRoot = join(root, "desktop");
  await mkdir(dataRoot);
  const provider = fauxProvider({
    provider: "remote-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "remote-test",
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
  const bot = await createBotApplication(
    {
      dataRoot: join(root, "bot"),
      adminToken: "remote-secret",
      workspaceRoot: join(root, "workspaces"),
      projects: [{ key: "cloud", rootPath: cwd }],
      runtime: { defaultThinkingLevel: "off", ...(defaultProvider ? { defaultProvider } : {}) },
    },
    { models },
  );
  cleanup.push(() => bot.close());
  const listening = Promise.withResolvers<number>();
  const server = serve({ fetch: bot.app.fetch, hostname: "127.0.0.1", port: 0 }, (address) =>
    listening.resolve(address.port),
  );
  cleanup.push(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${await listening.promise}`;
  const remote = new DesktopBot(dataRoot);
  cleanup.push(() => remote.close());
  return { root, dataRoot, cwd, bot, provider, server, url, remote };
}

test("Desktop executes and observes cloud work, persists its connection and never routes cloud IDs locally", async () => {
  const { remote, url, dataRoot, provider, cwd, server } = await fixture();
  const state = await remote.connect({ url, token: "remote-secret" });
  expect(JSON.stringify(state)).not.toContain("remote-secret");
  const workspace = state.library!.workspaces[0]!.id;
  const skill = join(cwd, ".agents", "skills", "cloud-only");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: cloud-only\ndescription: Skill installed on Bot\n---\nFollow cloud instructions.\n",
  );
  expect(
    (await remote.skills(workspace)).skills.some(
      (value) => value.name === "cloud-only" && value.source === "project",
    ),
  ).toBe(true);
  expect(workspace).toMatch(/^bot:/);
  const localOpen = vi.fn(async () => {
    throw new Error("local open must not run");
  });
  const localMove = vi.fn(async () => {
    throw new Error("local move must not run");
  });
  const local = {
    openThread: localOpen,
    moveThread: localMove,
    updateSettings: vi.fn(async () => ({})),
  } as unknown as LocalDesktopApplication;
  const desktop = withBot(local, remote);
  const created = await desktop.createThread(workspace, "desktop-draft");
  expect(created.id).toMatch(/^bot:/);
  expect((await desktop.createThread(workspace, "desktop-draft")).id).toBe(created.id);
  await desktop.configureThread(created.id, "remote-test", "one", "off");
  const snapshots: string[] = [];
  const stop = await desktop.subscribe(
    created.id,
    (value) => {
      snapshots.push(JSON.stringify(value));
    },
    () => {},
  );
  cleanup.push(stop);
  await expect.poll(() => snapshots.length).toBeGreaterThan(0);
  const initialCount = snapshots.length;
  if ("closeAllConnections" in server) server.closeAllConnections();
  await expect.poll(() => snapshots.length, { timeout: 5000 }).toBeGreaterThan(initialCount);
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "remote.txt", content: "Executed on Bot" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Cloud finished"),
  ]);
  const admission = await desktop.submit(created.id, "Write on cloud", "desktop-prompt");
  await expect
    .poll(() =>
      snapshots.some(
        (value) => value.includes(admission.operationId) && value.includes('"status":"completed"'),
      ),
    )
    .toBe(true);
  expect(await readFile(join(cwd, "remote.txt"), "utf8")).toBe("Executed on Bot");
  await desktop.openThread(created.id);
  expect(localOpen).not.toHaveBeenCalled();
  await expect(desktop.moveThread(created.id, "local-project")).rejects.toThrow("同一执行环境");
  expect(localMove).not.toHaveBeenCalled();
  await desktop.renameThread(created.id, "Cloud thread");
  expect(remote.status().library!.threads[0]!.title).toBe("Cloud thread");
  const reopened = new DesktopBot(dataRoot);
  cleanup.push(() => reopened.close());
  await reopened.initialize();
  expect(reopened.status()).toMatchObject({ status: "connected", url });
  expect((await reopened.open(created.id)).id).toBe(created.id);
  await desktop.archiveThread(created.id, true);
  expect(remote.status().library!.threads[0]!.archivedAt).toBeTypeOf("number");
  await desktop.archiveThread(created.id, false);
  await desktop.deleteThread(created.id);
  expect(remote.status().library!.threads).toEqual([]);
  await remote.disconnect();
  expect(remote.status().status).toBe("disconnected");
  await expect(remote.open(created.id)).rejects.toThrow("未连接");
});

test("failed authentication preserves the prior connection; offline catalogs never become local work", async () => {
  const { remote, url, dataRoot, server } = await fixture();
  await remote.connect({ url, token: "remote-secret" });
  const created = await remote.create(remote.status().library!.workspaces[0]!.id, "offline-thread");
  await expect(remote.connect({ url, token: "wrong" })).rejects.toThrow("令牌无效");
  expect(remote.status().status).toBe("connected");
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const reopened = new DesktopBot(dataRoot);
  cleanup.push(() => reopened.close());
  await reopened.initialize();
  expect(reopened.status().status).toBe("error");
  expect(reopened.status().library!.threads[0]!.id).toBe(created.id);
  await expect(reopened.open(created.id)).rejects.toThrow();
  expect(JSON.stringify(reopened.status())).not.toContain("remote-secret");
});

test("changing the Bot address isolates its catalog and rejects IDs belonging to the previous host", async () => {
  const first = await fixture();
  await first.remote.connect({ url: first.url, token: "remote-secret" });
  const created = await first.remote.create(
    first.remote.status().library!.workspaces[0]!.id,
    "first-host",
  );
  const second = await fixture();
  await first.remote.connect({ url: second.url, token: "remote-secret" });
  expect(first.remote.status().library!.threads).toEqual([]);
  await expect(first.remote.open(created.id)).rejects.toThrow("原来的 Bot");
  expect((await first.bot.core.threads()).length).toBe(1);
  expect((await second.bot.core.threads()).length).toBe(0);
});

test("Desktop creates a cloud folder and selects its remote workspace without local registration", async () => {
  const { remote, url, cwd } = await fixture();
  await remote.connect({ url, token: "remote-secret" });
  const local = {
    registerProject: vi.fn(async () => {
      throw new Error("must not register locally");
    }),
    updateSettings: vi.fn(async () => ({})),
  } as unknown as LocalDesktopApplication;
  const desktop = withBot(local, remote);
  const project = await desktop.createCloudProject("new-project", "desktop-project");
  expect(project.id).toMatch(/^bot:/);
  expect(project.rootPath).toBe(await realpath(join(cwd, "..", "new-project")));
  expect((await desktop.createCloudProject("new-project", "desktop-project")).id).toBe(project.id);
  const workspace = remote
    .status()
    .library!.workspaces.find((value) => value.projectId === project.id)!;
  const thread = await desktop.createThread(workspace.id, "new-cloud-draft");
  expect(
    remote.status().library!.threads.find((value) => value.id === thread.id)?.workspaceId,
  ).toBe(workspace.id);
  expect(local.registerProject).not.toHaveBeenCalled();
  await expect(desktop.createCloudProject("../escape", "bad-project")).rejects.toThrow("根目录");
});

test("Desktop imports its credentials directly to Bot and can remove the remote copy independently", async () => {
  const { remote, url } = await fixture();
  await remote.connect({ url, token: "remote-secret" });
  const values = { anthropic: { type: "api_key", key: "client-secret" } };
  const local = {
    exportBotCredentials: async () => structuredClone(values),
  } as unknown as LocalDesktopApplication;
  const desktop = withBot(local, remote);
  expect(await desktop.importBotCredentials()).toEqual({ imported: 1 });
  expect(remote.status().library!.credentials).toEqual([
    { providerId: "anthropic", type: "api_key" },
  ]);
  expect(JSON.stringify(remote.status())).not.toContain("client-secret");
  await desktop.removeBotCredential("anthropic");
  expect(remote.status().library!.credentials).toEqual([]);
  expect(values.anthropic.key).toBe("client-secret");
});

test("a cloud draft creates and submits with the chosen model before consulting an unavailable default", async () => {
  const { remote, url, provider } = await fixture("anthropic");
  const state = await remote.connect({ url, token: "remote-secret" });
  const workspace = state.library!.workspaces[0]!.id;
  const desktop = withBot(
    { updateSettings: async () => ({}) } as unknown as LocalDesktopApplication,
    remote,
  );
  provider.setResponses([fauxAssistantMessage("Hello from selected cloud model")]);
  const draft = new DraftThread("selected-cloud-model", {
    createThread: desktop.createThread,
    configureThread: desktop.configureThread,
    submit: (id, prompt, images) => desktop.submit(id, prompt, "selected-cloud-message", images),
  });
  const id = await draft.submit(workspace, "Hello", undefined, {
    provider: "remote-test",
    modelId: "one",
    thinkingLevel: "off",
  });
  expect((await desktop.openThread(id)).snapshot.configuration.model).toEqual({
    provider: "remote-test",
    modelId: "one",
  });
  await expect
    .poll(async () =>
      (await desktop.openThread(id)).snapshot.transcript.some(
        ({ message }) => message.role === "assistant",
      ),
    )
    .toBe(true);
});
