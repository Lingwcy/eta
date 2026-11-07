import { setImmediate } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { AppPathsService } from "@eta/core/platform/app-paths";
import { CredentialService } from "@eta/core/service/credentials/index";
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

test.each(
  [false, true].flatMap((busy) => ["logout", "relogin"].map((action) => ({ busy, action }))),
)(
  "credential $action immediately removes quota and rejects a held old library (busy=$busy)",
  async ({ busy, action }) => {
    const directory = await mkdtemp(join(tmpdir(), "eta-quota-library-"));
    const runtime = ManagedRuntime.make(
      CredentialService.layer.pipe(Layer.provide(AppPathsService.layer(directory))),
    );
    const credentials = await runtime.runPromise(CredentialService);
    const credential = {
      type: "oauth" as const,
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    };
    await credentials.loginStore.modify("openai-codex", async () => credential);
    const connection = (await runtime.runPromise(credentials.accountConnections))[0]!;
    const stale: DesktopLibrary = {
      projects: [],
      workspaces: [],
      threads: [],
      models: [],
      providers: [],
      credentials: [{ providerId: "openai-codex", type: "oauth" }],
      quotaConnections: [connection],
      settings: { defaultThinkingLevel: "off" },
    };
    const old = Promise.withResolvers<DesktopLibrary>();
    const replacement = Promise.withResolvers<DesktopLibrary>();
    const mutation = Promise.withResolvers<void>();
    let notify: ((reason?: "credentials") => void) | undefined;
    let calls = 0;
    const bridge = {
      library: async () => {
        calls++;
        if (calls === 1) return stale;
        if (calls === 2) return old.promise;
        if (calls === 3) return replacement.promise;
        return { ...stale, credentials: [], quotaConnections: [] };
      },
      subscribeLibrary: (listener: (reason?: "credentials") => void) => {
        notify = listener;
        const off = credentials.subscribe(() => listener("credentials"));
        return () => {
          notify = undefined;
          off();
        };
      },
      updateSettings: async () => stale.settings,
    };
    const client = new DesktopLibraryClient(bridge);
    let saving: Promise<void> | undefined;
    try {
      client.connect();
      await drain();
      expect(client.getSnapshot().library?.quotaConnections).toEqual([connection]);
      if (busy) {
        saving = client.act(() => mutation.promise);
        mutation.resolve();
        await vi.waitFor(() => expect(calls).toBe(2));
      } else {
        client.reload();
        expect(calls).toBe(2);
      }
      if (action === "logout") await credentials.store.delete("openai-codex");
      else await credentials.loginStore.modify("openai-codex", async () => credential);
      const nextConnections = await runtime.runPromise(credentials.accountConnections);
      if (action === "relogin")
        expect(nextConnections[0]?.connectionId).not.toBe(connection.connectionId);
      expect(client.getSnapshot().library?.quotaConnections).toEqual([]);
      if (busy) {
        old.resolve(stale);
        await vi.waitFor(() => expect(calls).toBe(3));
      } else {
        expect(calls).toBe(3);
        old.resolve(stale);
        await drain();
      }
      expect(client.getSnapshot().library?.quotaConnections).toEqual([]);
      const nextCredentials = action === "logout" ? [] : stale.credentials;
      replacement.resolve({
        ...stale,
        credentials: nextCredentials,
        quotaConnections: nextConnections,
      });
      await saving;
      await drain();
      expect(client.getSnapshot().library?.quotaConnections).toEqual(nextConnections);
      expect(client.getSnapshot().library?.credentials).toEqual(nextCredentials);
      expect(notify).toBeDefined();
    } finally {
      old.resolve(stale);
      replacement.resolve({ ...stale, credentials: [], quotaConnections: [] });
      mutation.resolve();
      await saving;
      client.dispose();
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("ordinary library changes retain the displayed quota while reloading", async () => {
  const state = fixture();
  const gate = Promise.withResolvers<DesktopLibrary>();
  try {
    state.bridge.library.mockResolvedValueOnce({
      ...state.current(),
      quotaConnections: [{ providerId: "openai-codex", connectionId: "a" }],
    });
    state.client.connect();
    await drain();
    state.bridge.library.mockImplementationOnce(() => gate.promise);
    state.notify();
    expect(state.client.getSnapshot().library?.quotaConnections).toEqual([
      { providerId: "openai-codex", connectionId: "a" },
    ]);
  } finally {
    gate.resolve(state.current());
    await drain();
    state.client.dispose();
  }
});
