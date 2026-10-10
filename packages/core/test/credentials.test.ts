import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { AppPathsService } from "@eta/core/platform/app-paths";
import { CredentialService } from "../src/service/credentials/index.ts";

const directories: string[] = [];
const runtimes: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((value) => value.dispose()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eta-credentials-service-"));
  directories.push(directory);
  const open = () => {
    const runtime = ManagedRuntime.make(
      CredentialService.layer.pipe(Layer.provide(AppPathsService.layer(directory))),
    );
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = open();
  const credentials = await runtime.runPromise(CredentialService);
  return { directory, open, runtime, credentials };
}
test("OAuth refresh is serialized, durable, preserves provider fields, and listing never leaks tokens", async () => {
  const { directory, open, runtime, credentials } = await setup();
  await credentials.store.modify("test", async () => ({
    type: "oauth",
    refresh: "0",
    access: "secret",
    expires: 1234,
    accountId: "keep-me",
  }));
  await Promise.all(
    Array.from({ length: 8 }, () =>
      credentials.store.modify("test", async (current) => {
        if (current?.type !== "oauth") throw new Error("missing credential");
        await Promise.resolve();
        return { ...current, refresh: String(Number(current.refresh) + 1) };
      }),
    ),
  );
  expect(await runtime.runPromise(credentials.list)).toEqual([
    { providerId: "test", type: "oauth" },
  ]);
  expect((await stat(join(directory, "credentials.json"))).mode & 0o777).toBe(0o600);
  await runtime.dispose();
  const next = open();
  const other = await next.runPromise(CredentialService);
  expect(await other.store.read("test")).toMatchObject({ refresh: "8", accountId: "keep-me" });
});
test("first-run import never restores credentials after an explicit logout", async () => {
  const { runtime, credentials, open } = await setup();
  const source = new InMemoryCredentialStore();
  await source.modify("test", async () => ({ type: "api_key", key: "secret" }));
  await runtime.runPromise(credentials.importOnce(source));
  await runtime.runPromise(credentials.remove("test"));
  await runtime.dispose();
  const next = open();
  const other = await next.runPromise(CredentialService);
  await next.runPromise(other.importOnce(source));
  expect(await next.runPromise(other.list)).toEqual([]);
});
test("failed writes preserve the previous credential", async () => {
  const { directory, runtime, credentials } = await setup();
  await runtime.runPromise(credentials.setApiKey("test", "original"));
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  expect(
    await runtime.runPromise(Effect.flip(credentials.setApiKey("test", "replacement"))),
  ).toMatchObject({ code: "StorageUnavailable" });
  expect(await credentials.store.read("test")).toEqual({ type: "api_key", key: "original" });
});
test("malformed credential JSON does not quote secret contents in errors", async () => {
  const { directory, open, runtime } = await setup();
  await runtime.dispose();
  const path = join(directory, "credentials.json");
  await writeFile(path, '{"secret":"do-not-leak');
  const next = open();
  const error: unknown = await next.runPromise(CredentialService).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "StorageCorrupt" });
  expect(String(error)).not.toContain("do-not-leak");
  expect(await readFile(path, "utf8")).toContain("do-not-leak");
});

test("bulk import is atomic, preserves OAuth fields, and copies independent snapshots", async () => {
  const { runtime, credentials, open } = await setup();
  const values = {
    one: { type: "api_key", key: "private-key" },
    two: {
      type: "oauth",
      access: "private-access",
      refresh: "private-refresh",
      expires: 1234,
      accountId: "account",
    },
  };
  await runtime.runPromise(credentials.import(values));
  values.one.key = "changed-client";
  expect(await credentials.store.read("one")).toEqual({ type: "api_key", key: "private-key" });
  await expect(
    runtime.runPromise(
      credentials.import({
        one: { type: "api_key", key: "replacement" },
        bad: { type: "oauth", access: "secret" },
      }),
    ),
  ).rejects.toThrow("认证格式无效");
  expect(await credentials.store.read("one")).toEqual({ type: "api_key", key: "private-key" });
  await runtime.dispose();
  const restored = await open().runPromise(CredentialService);
  expect(await restored.store.read("two")).toMatchObject({
    accountId: "account",
    refresh: "private-refresh",
  });
});
