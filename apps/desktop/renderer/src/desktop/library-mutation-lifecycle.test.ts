import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vite-plus/test";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import type { DesktopSettings } from "../../../src/shared/settings.ts";
import { DesktopLibraryClient } from "./library-client";

const cases = (["settings", "act"] as const).flatMap((entry) =>
  (["write", "write-error", "read", "read-error"] as const).flatMap((stage) =>
    (["dispose", "reconnect", "current"] as const).map((mode) => ({ entry, stage, mode })),
  ),
);

test.each(cases)("mutation lifecycle: $entry/$stage/$mode", async ({ entry, stage, mode }) => {
  let library: DesktopLibrary = {
    projects: [],
    workspaces: [],
    threads: [],
    models: [],
    providers: [],
    credentials: [],
    settings: { defaultThinkingLevel: "off" },
  };
  const old = Promise.withResolvers<void>();
  const next = Promise.withResolvers<void>();
  let entered = false;
  const failure = new Error("Original operation failed");
  let notify = () => {};
  let writes = 0;
  let reads = 0;
  const bridge = {
    library: vi.fn(async () => {
      const snapshot = library;
      if (++reads === 2 && stage.startsWith("read")) {
        entered = true;
        await old.promise;
        if (stage === "read-error") throw failure;
      }
      return snapshot;
    }),
    subscribeLibrary: (listener: () => void) => {
      notify = listener;
      return () => {
        notify = () => {};
      };
    },
    updateSettings: vi.fn(async (patch: Partial<DesktopSettings>) => {
      const call = ++writes;
      if (call === 1 && stage.startsWith("write")) {
        entered = true;
        await old.promise;
        if (stage === "write-error") throw failure;
      }
      if (call === 2) await next.promise;
      library = { ...library, settings: { ...library.settings, ...patch } };
      return library.settings;
    }),
  };
  const client = new DesktopLibraryClient(bridge);
  const start = (skillsEnabled: boolean) =>
    entry === "settings"
      ? client.updateSettings({ skillsEnabled })
      : client.act(async () => {
          await bridge.updateSettings({ skillsEnabled });
        });
  let original: Promise<unknown> | undefined;
  let replacement: Promise<unknown> | undefined;
  try {
    client.connect();
    await setImmediate();
    original = start(false).catch((error: unknown) => error);
    await expect.poll(() => entered, { timeout: 1000 }).toBe(true);
    if (mode !== "current") client.dispose();
    if (mode === "reconnect") {
      client.connect();
      await setImmediate();
      replacement = start(true).catch((error: unknown) => error);
      expect(bridge.updateSettings).toHaveBeenCalledTimes(2);
      notify(); // The old read must not consume this replacement's invalidation.
      expect(client.getSnapshot().busy).toBe(true);
    }
    const before = bridge.library.mock.calls.length;
    old.resolve();
    const result = await original;
    await setImmediate();
    expect(result).toBe(entry === "settings" && stage.endsWith("error") ? failure : undefined);
    if (mode !== "current") {
      expect(bridge.library).toHaveBeenCalledTimes(before);
      expect(client.getSnapshot().error).toBeNull();
      expect(client.getSnapshot().busy).toBe(mode === "reconnect");
    } else {
      expect(client.getSnapshot().busy).toBe(false);
      expect(client.getSnapshot().error).toBe(stage.endsWith("error") ? failure.message : null);
    }
    if (replacement) {
      next.resolve();
      await replacement;
      await setImmediate();
      expect(client.getSnapshot()).toMatchObject({
        busy: false,
        error: null,
        library: { settings: { skillsEnabled: true } },
      });
    }
  } finally {
    old.resolve();
    next.resolve();
    await original;
    await replacement;
    await setImmediate();
    client.dispose();
  }
});

test.each(["settings", "act"] as const)(
  "disposed clients cannot admit new %s operations",
  async (entry) => {
    const library: DesktopLibrary = {
      projects: [],
      workspaces: [],
      threads: [],
      models: [],
      providers: [],
      credentials: [],
      settings: { defaultThinkingLevel: "off" },
    };
    const action = vi.fn(async () => library.settings);
    const client = new DesktopLibraryClient({
      library: async () => library,
      subscribeLibrary: () => () => {},
      updateSettings: action,
    });
    try {
      client.connect();
      await setImmediate();
      client.dispose();
      if (entry === "settings") await client.updateSettings({ skillsEnabled: false });
      else
        await client.act(async () => {
          await action();
        });
      expect(action).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  },
);
