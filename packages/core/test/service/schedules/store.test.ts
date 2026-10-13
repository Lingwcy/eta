import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { AppPathsService } from "@eta/core/platform/app-paths";
import {
  ScheduleStoreService,
  decodeScheduleStore,
  emptyScheduleStore,
} from "@eta/core/service/schedules/store";
import type { Schedule } from "@eta/core/shared/schedules";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eta-schedules-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const open = () => {
    const runtime = ManagedRuntime.make(
      ScheduleStoreService.layer.pipe(Layer.provide(AppPathsService.layer(root))),
    );
    cleanups.push(() => runtime.dispose());
    return runtime;
  };
  return { root, open };
}
const schedule = (id: string): Schedule => ({
  id,
  threadId: "thread",
  name: "Review",
  prompt: "Review the repository",
  rule: { type: "interval", everyMs: 300_000, anchorAt: 0 },
  state: "active",
  nextRunAt: 300_000,
  consumedThrough: 0,
  revision: 1,
  source: "user",
  missedWindowMs: 86_400_000,
  createdAt: 0,
  updatedAt: 0,
});

test("serializes concurrent transactions and reopens the independently versioned store", async () => {
  const { root, open } = await fixture();
  const runtime = open();
  const store = await runtime.runPromise(ScheduleStoreService);
  expect(await runtime.runPromise(store.read)).toEqual(emptyScheduleStore());
  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      runtime.runPromise(
        store.update((state) => ({
          ...state,
          schedules: { ...state.schedules, [index]: schedule(String(index)) },
        })),
      ),
    ),
  );
  const state = await runtime.runPromise(store.read);
  expect(Object.keys(state.schedules)).toHaveLength(25);
  expect(state.revision).toBe(25);
  expect(JSON.parse(await readFile(join(root, "schedules.json"), "utf8"))).toEqual(state);
  await runtime.dispose();
  const reopened = open();
  expect(
    await reopened.runPromise(Effect.flatMap(ScheduleStoreService, (service) => service.read)),
  ).toEqual(state);
});

test("invalid transactions leave disk intact and do not poison the write queue", async () => {
  const { root, open } = await fixture();
  const runtime = open();
  const store = await runtime.runPromise(ScheduleStoreService);
  await runtime.runPromise(
    store.update((state) => ({ ...state, schedules: { one: schedule("one") } })),
  );
  const before = await readFile(join(root, "schedules.json"), "utf8");
  const error = await runtime.runPromise(
    Effect.flip(
      store.update((state) => ({
        ...state,
        schedules: { bad: schedule("wrong-key") },
      })),
    ),
  );
  expect(error.code).toBe("StorageCorrupt");
  expect(await readFile(join(root, "schedules.json"), "utf8")).toBe(before);
  await runtime.runPromise(
    store.update((state) => ({
      ...state,
      schedules: { ...state.schedules, two: schedule("two") },
    })),
  );
  expect(Object.keys((await runtime.runPromise(store.read)).schedules)).toEqual(["one", "two"]);
});

test.each([
  "{",
  JSON.stringify({ ...emptyScheduleStore(), version: 2 }),
  JSON.stringify({ ...emptyScheduleStore(), extra: true }),
])("refuses to reset corrupt or unsupported disk content %s", async (text) => {
  const { root, open } = await fixture();
  await writeFile(join(root, "schedules.json"), text);
  const runtime = open();
  const store = await runtime.runPromise(ScheduleStoreService);
  expect((await runtime.runPromise(Effect.flip(store.read))).code).toBe("StorageCorrupt");
  expect((await runtime.runPromise(Effect.flip(store.update((state) => state)))).code).toBe(
    "StorageCorrupt",
  );
  expect(await readFile(join(root, "schedules.json"), "utf8")).toBe(text);
});

test("validates frozen occurrence relations, admission receipts and persistent cursors", () => {
  const state = { ...emptyScheduleStore(), schedules: { one: schedule("one") } };
  expect(() =>
    decodeScheduleStore({
      ...state,
      schedules: { one: { ...schedule("one"), consumedThrough: 300_000 } },
    }),
  ).toThrow();
  expect(() =>
    decodeScheduleStore({ ...state, schedules: { one: { ...schedule("one"), state: "paused" } } }),
  ).toThrow();
  const occurrence = {
    id: "run",
    scheduleId: "one",
    threadId: "thread",
    scheduleRevision: 1,
    scheduledAt: 0,
    source: "automatic",
    name: "Review",
    prompt: "Original prompt",
    rule: schedule("one").rule,
    requestId: "delivery",
    detectedAt: 0,
    state: "pending",
  };
  expect(
    decodeScheduleStore({ ...state, occurrences: { run: occurrence } }).occurrences.run.prompt,
  ).toBe("Original prompt");
  expect(() =>
    decodeScheduleStore({ ...state, occurrences: { run: { ...occurrence, state: "admitted" } } }),
  ).toThrow();
  expect(() =>
    decodeScheduleStore({ ...state, occurrences: { run: { ...occurrence, threadId: "other" } } }),
  ).toThrow();
  expect(() =>
    decodeScheduleStore({
      ...state,
      occurrences: { run: occurrence, duplicate: { ...occurrence, id: "duplicate" } },
    }),
  ).toThrow();
});

test("rejects approval and lifecycle states without the matching atomic request receipt", () => {
  const state = emptyScheduleStore();
  const proposal = {
    id: "proposal",
    threadId: "thread",
    change: { action: "create", name: "Review", prompt: "Review", rule: schedule("one").rule },
    workspaceId: "workspace",
    contentFingerprint: "hash",
    sourceIdentity: "tool",
    createdAt: 0,
    expiresAt: 86_400_000,
    state: "approved",
    scheduleId: "one",
    decisionRequestId: "approve",
  };
  expect(() => decodeScheduleStore({ ...state, proposals: { proposal } })).toThrow();
  expect(() =>
    decodeScheduleStore({
      ...state,
      lifecycleIntents: {
        archive: {
          requestId: "archive",
          threadId: "thread",
          action: "archive",
          phase: "prepared",
          createdAt: 0,
        },
      },
    }),
  ).toThrow();
});
