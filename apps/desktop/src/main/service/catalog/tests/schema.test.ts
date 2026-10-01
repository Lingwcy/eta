import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { decodeCatalog, encodeCatalog, parseCatalog } from "../schema.ts";
import { catalogFixture } from "./test-fixtures.ts";

test("round trips versioned metadata and optional session fields without leaking the disk version", async () => {
  const state = catalogFixture();
  const encoded = await Effect.runPromise(encodeCatalog(state));
  expect(JSON.parse(encoded).version).toBe(1);
  expect(await Effect.runPromise(parseCatalog(encoded))).toEqual(state);
});

test("reports malformed JSON", async () => {
  const error = await Effect.runPromise(Effect.flip(parseCatalog("{")));
  expect(error.reason).toBe("InvalidJson");
});

test("reports unsupported versions explicitly", async () => {
  const error = await Effect.runPromise(Effect.flip(decodeCatalog({ version: 2 })));
  expect(error.reason).toBe("UnsupportedVersion");
  expect(error.message).toContain("2");
});

test.each([
  { projects: undefined },
  { projects: [{ id: "project" }] },
  { threads: [{ ...catalogFixture().threads[0], createdAt: "today" }] },
  { threads: [{ ...catalogFixture().threads[0], archivedAt: -1 }] },
  { workspaces: [{ ...catalogFixture().workspaces[0], cwd: "relative/path" }] },
  { unexpectedField: true },
])("rejects invalid or unknown fields: %j", async (overrides) => {
  const error = await Effect.runPromise(
    Effect.flip(decodeCatalog({ version: 1, ...catalogFixture(), ...overrides })),
  );
  expect(error.reason).toBe("InvalidFields");
});

test("validates references after decoding fields", async () => {
  const error = await Effect.runPromise(
    Effect.flip(decodeCatalog({ version: 1, ...catalogFixture(), workspaces: [] })),
  );
  expect(error.reason).toBe("InvalidRelations");
  expect(error.message).toContain("WorkspaceNotFound");
});

test("validates state before encoding it for disk", async () => {
  const error = await Effect.runPromise(
    Effect.flip(encodeCatalog({ ...catalogFixture(), projects: [] })),
  );
  expect(error.reason).toBe("InvalidRelations");
});
