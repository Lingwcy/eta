import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vite-plus/test";
import { BotClient } from "./client.ts";
import { MobileStore, draftKey } from "./store.ts";
import { json, library, memoryStorage } from "./fixtures.test-support.ts";

const cases = (["draft", "background"] as const).flatMap((source) =>
  (["current", "forget", "dispose", "clear-fails", "disconnect"] as const).flatMap((action) =>
    [false, true].map((fail) => ({ source, action, fail })),
  ),
);

test.each(cases)(
  "background cache outcome: $source $action failure=$fail",
  async ({ source, action, fail }) => {
    vi.useFakeTimers();
    const saved = memoryStorage();
    const gate = Promise.withResolvers<void>();
    const cacheFailure = new Error("Old cache write failed");
    const clearFailure = new Error("Secure storage clear failed");
    const save = saved.storage.saveCache;
    const clear = saved.storage.clear;
    let hold = false;
    let entered = false;
    saved.storage.saveCache = async (url, cache) => {
      if (hold) {
        hold = false;
        entered = true;
        await gate.promise;
      }
      await save(url, cache);
    };
    saved.storage.clear = vi.fn(async () => {
      if (action === "clear-fails") throw clearFailure;
      await clear();
    });
    const store = new MobileStore(
      saved.storage,
      (connection) => new BotClient(connection, async () => json(library)),
      () => "request",
    );
    let completion: Promise<unknown> | undefined;
    try {
      await store.connect({ url: "https://bot", token: "fixture-token" });
      hold = true;
      store.setDraft("Retain this draft unless explicitly forgotten");
      if (source === "draft") await vi.advanceTimersByTimeAsync(300);
      else {
        store.setForeground(false);
        await setImmediate();
      }
      expect(entered).toBe(true);
      // A UI clear after backgrounding occurs after foreground recovery has started.
      if (source === "background" && (action === "forget" || action === "clear-fails")) {
        store.setForeground(true);
        await setImmediate();
      }
      if (action === "forget" || action === "clear-fails")
        completion = store.disconnect(true).catch((error: unknown) => error);
      else if (action === "disconnect")
        completion = store.disconnect().catch((error: unknown) => error);
      else if (action === "dispose") store.dispose();
      const before = store.getSnapshot();
      if (fail) gate.reject(cacheFailure);
      else gate.resolve();
      const result = await completion;
      await setImmediate();
      expect(result).toBe(action === "clear-fails" ? clearFailure : undefined);
      if (action === "current") {
        expect(store.getSnapshot().error).toBe(
          fail
            ? source === "draft"
              ? "无法保存草稿：Old cache write failed"
              : "Old cache write failed"
            : undefined,
        );
        expect(store.getSnapshot().status).toBe("connected");
      } else {
        expect(store.getSnapshot().error).toBeUndefined();
        if (action === "dispose") expect(store.getSnapshot()).toBe(before);
        else expect(store.getSnapshot()).toMatchObject({ status: "disconnected", drafts: {} });
      }
      if (action === "forget") {
        expect(saved.storage.clear).toHaveBeenCalledOnce();
        expect(saved.caches.size).toBe(0);
        expect(saved.connection()).toBeUndefined();
      } else if (action === "disconnect") {
        expect(saved.storage.clear).not.toHaveBeenCalled();
        expect(saved.connection()).toBeUndefined();
        expect(saved.caches.get("https://bot")?.drafts[draftKey(before)]).toBe(
          "Retain this draft unless explicitly forgotten",
        );
      } else if (action === "clear-fails") {
        expect(saved.storage.clear).toHaveBeenCalledOnce();
        expect(saved.connection()?.url).toBe("https://bot");
      }
    } finally {
      gate.resolve();
      await completion;
      await setImmediate();
      store.dispose();
      vi.useRealTimers();
    }
  },
);
