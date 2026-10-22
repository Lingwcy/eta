import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore, type CoreClient } from "../src/client.ts";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const core of clients.splice(0)) await core.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const invalid = { provider: "test", modelId: "missing", thinkingLevel: "off" as const };
async function fixture(mode: "explicit" | "defaults" | "empty" = "explicit") {
  const directory = await mkdtemp(join(tmpdir(), "eta-temporary-validation-"));
  directories.push(directory);
  const root = join(directory, "temporary");
  const models = createModels();
  if (mode !== "empty")
    models.setProvider(fauxProvider({ provider: "test", models: [{ id: "one" }] }).provider);
  const open = async () => {
    const core = await createCore({
      dataRoot: join(directory, "data"),
      home: directory,
      models,
      settings: {
        read: Effect.succeed({
          defaultProvider: "test",
          defaultModel: mode === "defaults" ? "missing" : "one",
          defaultThinkingLevel: "off",
        }),
        subscribe: () => () => {},
      },
      environment: {
        userAgent: "eta-core-test",
        shutdown: "preserve",
        temporaryWorkspacesRoot: root,
      },
    });
    clients.push(core);
    return core;
  };
  return { core: await open(), open, root };
}
async function entries(root: string) {
  return readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
}

test.each(["explicit", "defaults", "empty"] as const)(
  "unavailable %s model does not allocate persistent temporary workspaces",
  async (mode) => {
    const { core, open, root } = await fixture(mode);
    for (let id = 0; id < 3; id++)
      await expect(
        core.createThread(null, "rejected-" + id, mode === "explicit" ? invalid : undefined),
      ).rejects.toMatchObject({ code: "ModelUnavailable" });
    await core.close();
    const reopened = await open();
    expect({
      workspaces: await reopened.workspaces(),
      threads: await reopened.threads(),
      entries: await entries(root),
    }).toEqual({ workspaces: [], threads: [], entries: [] });
  },
);

test("correcting the model reuses the request normally without duplicate workspaces", async () => {
  const { core, open, root } = await fixture();
  await expect(core.createThread(null, "retry", invalid)).rejects.toMatchObject({
    code: "ModelUnavailable",
  });
  const created = await core.createThread(null, "retry");
  expect((await core.createThread(null, "retry")).id).toBe(created.id);
  await core.close();
  const reopened = await open();
  expect((await reopened.createThread(null, "retry")).id).toBe(created.id);
  expect(await reopened.workspaces()).toHaveLength(1);
  expect(await entries(root)).toHaveLength(1);
}, 10_000);

test("explicit workspace validation still precedes unavailable model selection", async () => {
  const { core, root } = await fixture();
  await expect(
    core.createThread("missing-workspace", "invalid-workspace", invalid),
  ).rejects.toMatchObject({ code: "NotFound" });
  expect(await core.workspaces()).toEqual([]);
  expect(await entries(root)).toEqual([]);
});
