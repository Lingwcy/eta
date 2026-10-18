import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vite-plus/test";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import type { DesktopSettings } from "../../../src/shared/settings.ts";
import { DesktopLibraryClient } from "./library-client";

function fixture() {
  let library: DesktopLibrary = {
    projects: [],
    workspaces: [],
    threads: [],
    models: [],
    providers: [],
    credentials: [],
    settings: { defaultThinkingLevel: "off" },
  };
  let listener = () => {};
  const bridge = {
    library: vi.fn(async () => library),
    subscribeLibrary: (next: () => void) => {
      listener = next;
      return () => {
        listener = () => {};
      };
    },
    updateSettings: async (patch: Partial<DesktopSettings>) => {
      library = { ...library, settings: { ...library.settings, ...patch } };
      return library.settings;
    },
  };
  return {
    current: () => library,
    client: new DesktopLibraryClient(bridge),
    bridge,
    notify: () => listener(),
    setLatest: () => {
      library = { ...library, settings: { ...library.settings, skillsEnabled: false } };
    },
  };
}

// reload is intentionally fire-and-forget. A check-phase barrier drains all settled
// Promise continuations before a negative assertion, without a fixed wall-clock sleep.
async function drain() {
  await setImmediate();
}

test.each(["refresh", "reload", "notification", "settings", "reconnect"] as const)(
  "an obsolete background failure cannot replace a newer %s result",
  async (replacement) => {
    const state = fixture();
    const gate = Promise.withResolvers<DesktopLibrary>();
    try {
      state.client.connect();
      await drain();
      state.bridge.library.mockImplementationOnce(() => gate.promise);
      state.client.reload();
      state.setLatest();
      if (replacement === "refresh") await state.client.refresh();
      else if (replacement === "reload") state.client.reload();
      else if (replacement === "notification") state.notify();
      else if (replacement === "settings")
        await state.client.updateSettings({ skillsEnabled: false });
      else {
        state.client.dispose();
        state.client.connect();
      }
      await drain();
      expect(state.client.getSnapshot().library?.settings.skillsEnabled).toBe(false);
      expect(state.client.getSnapshot().error).toBeNull();
      const reads = state.bridge.library.mock.calls.length;
      gate.reject(new Error("Obsolete catalog failure"));
      await drain();
      expect(state.client.getSnapshot()).toMatchObject({
        busy: false,
        error: null,
        library: { settings: { skillsEnabled: false } },
      });
      expect(state.bridge.library).toHaveBeenCalledTimes(reads);
      await state.client.updateSettings({ skillsEnabled: true });
      expect(state.client.getSnapshot()).toMatchObject({
        busy: false,
        error: null,
        library: { settings: { skillsEnabled: true } },
      });
    } finally {
      gate.resolve(state.current());
      await drain();
      state.client.dispose();
    }
  },
);

test.each([false, true])(
  "a background failure respects disposal=%s and a current retry",
  async (dispose) => {
    const state = fixture();
    const gate = Promise.withResolvers<DesktopLibrary>();
    try {
      state.client.connect();
      await drain();
      state.bridge.library.mockImplementationOnce(() => gate.promise);
      state.notify();
      if (dispose) state.client.dispose();
      gate.reject(new Error("Current catalog failure"));
      await drain();
      expect(state.client.getSnapshot().error).toBe(dispose ? null : "Current catalog failure");
      if (dispose) state.client.connect();
      state.client.clearError();
      state.setLatest();
      state.client.reload();
      await drain();
      expect(state.client.getSnapshot()).toMatchObject({
        error: null,
        library: { settings: { skillsEnabled: false } },
      });
    } finally {
      gate.resolve(state.current());
      await drain();
      state.client.dispose();
    }
  },
);

test.each([false, true])(
  "foreground rejection remains observable when superseded=%s",
  async (superseded) => {
    const state = fixture();
    const gate = Promise.withResolvers<DesktopLibrary>();
    const failure = new Error("Foreground failure");
    let result: Promise<unknown> | undefined;
    try {
      state.client.connect();
      await drain();
      state.bridge.library.mockImplementationOnce(() => gate.promise);
      result = state.client.refresh().catch((error: unknown) => error);
      if (superseded) {
        state.setLatest();
        await state.client.refresh();
      }
      gate.reject(failure);
      expect(await result).toBe(failure);
      await drain();
      expect(state.client.getSnapshot().error).toBeNull();
      if (superseded)
        expect(state.client.getSnapshot().library?.settings.skillsEnabled).toBe(false);
    } finally {
      gate.resolve(state.current());
      await result;
      await drain();
      state.client.dispose();
    }
  },
);

test("admitting a settings mutation invalidates earlier background errors before its write settles", async () => {
  const state = fixture();
  const old = Promise.withResolvers<DesktopLibrary>();
  const write = Promise.withResolvers<void>();
  let saving: Promise<void> | undefined;
  try {
    state.client.connect();
    await drain();
    state.bridge.library.mockImplementationOnce(() => old.promise);
    state.client.reload();
    const update = state.bridge.updateSettings;
    state.bridge.updateSettings = async (patch) => {
      await write.promise;
      return update(patch);
    };
    saving = state.client.updateSettings({ skillsEnabled: false });
    old.reject(new Error("Pre-save background failure"));
    await drain();
    expect(state.client.getSnapshot()).toMatchObject({ busy: true, error: null });
    write.resolve();
    await saving;
    expect(state.client.getSnapshot()).toMatchObject({
      busy: false,
      error: null,
      library: { settings: { skillsEnabled: false } },
    });
  } finally {
    old.resolve(state.current());
    write.resolve();
    await saving?.catch(() => {});
    await drain();
    state.client.dispose();
  }
});
