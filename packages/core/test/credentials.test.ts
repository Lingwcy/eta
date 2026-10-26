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

test.each([NaN, Infinity, -Infinity])(
  "OAuth writes reject non-finite expiry %s without replacing durable credentials",
  async (expires) => {
    const { directory, runtime, credentials, open } = await setup();
    const original = {
      type: "oauth" as const,
      refresh: "fake-refresh",
      access: "fake-access",
      expires: 1234,
      accountId: "retained",
    };
    await credentials.store.modify("stable", async () => original);
    const path = join(directory, "credentials.json");
    const before = await readFile(path, "utf8");
    await expect(
      credentials.store.modify("stable", async () => ({ ...original, expires })),
    ).rejects.toMatchObject({ code: "InvalidInput" });
    await expect(
      runtime.runPromise(
        credentials.import({
          stable: { ...original, expires },
          added: { type: "api_key", key: "fake-added" },
        }),
      ),
    ).rejects.toMatchObject({ code: "InvalidInput" });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await runtime.runPromise(credentials.export)).toEqual({ stable: original });
    await runtime.dispose();
    const restored = await open().runPromise(CredentialService);
    expect(await restored.store.read("stable")).toEqual(original);
    await expect(restored.store.read("added")).resolves.toBeUndefined();
  },
);

test.each([NaN, Infinity, -Infinity])(
  "first-run migration rejects non-finite OAuth expiry %s atomically and can retry",
  async (expires) => {
    const { directory, runtime, credentials, open } = await setup();
    const source = new InMemoryCredentialStore();
    await source.modify("ordinary", async () => ({ type: "api_key", key: "fake-key" }));
    const valid = {
      type: "oauth" as const,
      refresh: "fake-refresh",
      access: "fake-access",
      expires: 1234,
      accountId: "retained",
    };
    await source.modify("oauth", async () => ({ ...valid, expires }));
    await expect(runtime.runPromise(credentials.importOnce(source))).rejects.toMatchObject({
      code: "InvalidInput",
    });
    expect(await runtime.runPromise(credentials.export)).toEqual({});
    await expect(readFile(join(directory, "credentials.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await source.modify("oauth", async () => valid);
    await runtime.runPromise(credentials.importOnce(source));
    await runtime.dispose();
    const restored = await open().runPromise(CredentialService);
    expect(await restored.store.read("oauth")).toEqual(valid);
    expect(await restored.store.read("ordinary")).toEqual({ type: "api_key", key: "fake-key" });
  },
);

test.each([0, -1, 1234.5, Number.MAX_VALUE])(
  "finite OAuth expiry %s survives JSON persistence without coercion",
  async (expires) => {
    const { runtime, credentials, open } = await setup();
    const value = {
      type: "oauth" as const,
      refresh: "fake-refresh",
      access: "fake-access",
      expires,
      accountId: "retained",
    };
    const source = new InMemoryCredentialStore();
    await source.modify("oauth", async () => value);
    await runtime.runPromise(credentials.importOnce(source));
    await credentials.store.modify("oauth", async () => value);
    await runtime.runPromise(credentials.import({ oauth: value }));
    await runtime.dispose();
    const restored = await open().runPromise(CredentialService);
    expect(await restored.store.read("oauth")).toEqual(value);
  },
);

test("overflowed OAuth expiry in an existing JSON file is rejected without rewriting secrets", async () => {
  const { directory, runtime, open } = await setup();
  await runtime.dispose();
  const path = join(directory, "credentials.json");
  const original =
    '{"version":1,"credentials":{"oauth":{"type":"oauth","refresh":"fake-refresh","access":"fake-access","expires":1e400}}}';
  await writeFile(path, original);
  const error: unknown = await open()
    .runPromise(CredentialService)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "StorageCorrupt" });
  expect(String(error)).not.toContain("fake-refresh");
  expect(String(error)).not.toContain("fake-access");
  expect(await readFile(path, "utf8")).toBe(original);
});
