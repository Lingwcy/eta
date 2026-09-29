import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { AppPaths, makeAppPaths } from "./app-paths.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDataRoot() {
  const directory = await mkdtemp(join(tmpdir(), "eta-app-paths-"));
  directories.push(directory);
  return directory;
}

test("derives every application storage location from one data root", async () => {
  const dataRoot = await temporaryDataRoot();

  expect(makeAppPaths(dataRoot)).toEqual({
    dataRoot,
    sessionsRoot: join(dataRoot, "sessions"),
    catalogPath: join(dataRoot, "catalog.json"),
    settingsPath: join(dataRoot, "settings.json"),
  });
});

test("provides the paths as an Effect service", async () => {
  const dataRoot = await temporaryDataRoot();
  const paths = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* AppPaths;
    }).pipe(Effect.provide(AppPaths.layer(dataRoot))),
  );

  expect(paths).toEqual(makeAppPaths(dataRoot));
});
