import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BotStore } from "./store.ts";

test("closing rejects late ingress while admitted and coalesced requests drain", async () => {
  const store = new BotStore(":memory:");
  const firstGate = Promise.withResolvers<string>();
  const lateGate = Promise.withResolvers<string>();
  const executed: string[] = [];
  let firstStarted = false;
  let lateStarted = false;
  let lateSettled = false;
  const first = store.request("scope", "first", "payload", async () => {
    firstStarted = true;
    executed.push("first");
    return firstGate.promise;
  });
  const duplicate = store.request("scope", "first", "payload", async () => {
    executed.push("duplicate");
    return "unexpected duplicate";
  });
  const admitted = Promise.allSettled([first, duplicate]);
  let closing: Promise<void> | undefined;
  let late: Promise<unknown> | undefined;
  try {
    await expect.poll(() => firstStarted, { timeout: 3000 }).toBe(true);
    closing = store.close();
    late = store
      .request("scope", "late", "late payload", async () => {
        lateStarted = true;
        executed.push("late");
        return lateGate.promise;
      })
      .then(
        (value) => ({ status: "completed", value }),
        (error: unknown) => ({
          status: "rejected",
          code: error instanceof Error && "code" in error ? error.code : undefined,
          httpStatus: error instanceof Error && "status" in error ? error.status : undefined,
        }),
      )
      .finally(() => {
        lateSettled = true;
      });
    // The old implementation starts this callback; a closed admission rejects instead.
    await expect.poll(() => lateStarted || lateSettled, { timeout: 3000 }).toBe(true);
    firstGate.resolve("first result");
    await closing;
    lateGate.resolve("late result");
    expect(await late).toEqual({ status: "rejected", code: "RuntimeClosing", httpStatus: 503 });
    expect(executed).toEqual(["first"]);
    expect(await admitted).toEqual([
      { status: "fulfilled", value: "first result" },
      { status: "fulfilled", value: "first result" },
    ]);
  } finally {
    firstGate.resolve("cleanup");
    lateGate.resolve("cleanup");
    await Promise.allSettled([admitted, ...(late ? [late] : []), closing ?? store.close()]);
  }
}, 10000);

test("concurrent close calls coalesce and closed requests report RuntimeClosing", async () => {
  const store = new BotStore(":memory:");
  const outcomes = await Promise.allSettled([store.close(), store.close()]);
  expect(outcomes).toEqual([
    { status: "fulfilled", value: undefined },
    { status: "fulfilled", value: undefined },
  ]);
  let executed = false;
  await expect(
    store.request("scope", "closed", "payload", async () => {
      executed = true;
      return "unexpected";
    }),
  ).rejects.toMatchObject({ status: 503, code: "RuntimeClosing" });
  expect(executed).toBe(false);
  await expect(store.close()).resolves.toBeUndefined();
});

test("closing drains an admitted callback and its durable receipt replays after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-bot-store-close-"));
  const path = join(directory, "requests.sqlite");
  const store = new BotStore(path);
  let reopened: BotStore | undefined;
  let executions = 0;
  try {
    const pending = store.request("scope", "admitted", "payload", async () => {
      executions++;
      return { value: "persisted" };
    });
    // The callback starts in a microtask, after close begins, but was already admitted.
    const closing = store.close();
    await expect(pending).resolves.toEqual({ value: "persisted" });
    await closing;
    reopened = new BotStore(path);
    expect(
      await reopened.request("scope", "admitted", "payload", async () => {
        executions++;
        return { value: "unexpected replay execution" };
      }),
    ).toEqual({ value: "persisted" });
    await expect(
      reopened.request("scope", "admitted", "different", async () => {
        executions++;
        return "unexpected conflict execution";
      }),
    ).rejects.toMatchObject({ status: 409, code: "RequestConflict" });
    expect(executions).toBe(1);
  } finally {
    await Promise.allSettled([store.close(), ...(reopened ? [reopened.close()] : [])]);
    await rm(directory, { recursive: true, force: true });
  }
});
