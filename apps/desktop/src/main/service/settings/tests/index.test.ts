import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { AppPathsService } from "../../../platform/app-paths.ts";
import { DesktopSettingsService } from "../index.ts";

const directories: string[] = [];
const runtimes: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((value) => value.dispose()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eta-settings-service-"));
  directories.push(directory);
  const open = () => {
    const runtime = ManagedRuntime.make(
      DesktopSettingsService.layer.pipe(Layer.provide(AppPathsService.layer(directory))),
    );
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = open();
  const settings = await runtime.runPromise(DesktopSettingsService);
  return { directory, open, runtime, settings };
}
test("serialized patches preserve unrelated fields and survive reopening", async () => {
  const { directory, open, runtime, settings } = await setup();
  expect(await runtime.runPromise(settings.read)).toEqual({ defaultThinkingLevel: "off" });
  await runtime.runPromise(
    Effect.all(
      [
        settings.update({ defaultProvider: "eta-test" }),
        settings.update({ defaultModel: "one" }),
        settings.update({ activeThreadId: "thread" }),
      ],
      { concurrency: "unbounded" },
    ),
  );
  const value = await runtime.runPromise(settings.read);
  expect(value).toMatchObject({
    defaultProvider: "eta-test",
    defaultModel: "one",
    activeThreadId: "thread",
  });
  await runtime.dispose();
  const next = open();
  const reopened = await next.runPromise(DesktopSettingsService);
  expect(await next.runPromise(reopened.read)).toEqual(value);
  expect(JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))).toMatchObject({
    version: 1,
  });
});
test("invalid input and failed persistence do not publish new settings", async () => {
  const { directory, runtime, settings } = await setup();
  expect(
    await runtime.runPromise(Effect.flip(settings.update({ defaultProvider: "" }))),
  ).toMatchObject({ code: "InvalidInput" });
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  expect(
    await runtime.runPromise(Effect.flip(settings.update({ defaultModel: "one" }))),
  ).toMatchObject({ code: "StorageUnavailable" });
  expect(await runtime.runPromise(settings.read)).toEqual({ defaultThinkingLevel: "off" });
});
test.each(["{", '{"version":2,"settings":{}}'])(
  "corrupt or unsupported settings are reported without overwriting %s",
  async (content) => {
    const { directory, runtime, open } = await setup();
    await runtime.dispose();
    const path = join(directory, "settings.json");
    await writeFile(path, content);
    const next = open();
    await expect(next.runPromise(DesktopSettingsService)).rejects.toMatchObject({
      code: "StorageCorrupt",
    });
    expect(await readFile(path, "utf8")).toBe(content);
  },
);

test("tool toggles persist across restart and can be restored without losing other settings", async () => {
  const { runtime, settings, open } = await setup();
  await runtime.runPromise(
    settings.update({ disabledTools: ["bash", "write"], blockImages: true }),
  );
  await runtime.dispose();
  const next = open();
  const reopened = await next.runPromise(DesktopSettingsService);
  expect(await next.runPromise(reopened.read)).toMatchObject({
    disabledTools: ["bash", "write"],
    blockImages: true,
  });
  await next.runPromise(reopened.update({ disabledTools: [] }));
  expect(await next.runPromise(reopened.read)).toMatchObject({
    disabledTools: [],
    blockImages: true,
  });
});
