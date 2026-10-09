import { expect, test } from "vite-plus/test";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import type { DesktopSettings } from "../../../src/shared/settings.ts";
import { DesktopLibraryClient } from "./library-client.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  let library: DesktopLibrary = {
    projects: [],
    workspaces: [],
    threads: [],
    models: [],
    providers: [],
    credentials: [],
    settings: { defaultThinkingLevel: "off" },
  };
  let listener: (() => void) | undefined;
  let reads = 0;
  const bridge = {
    library: async () => {
      reads++;
      return library;
    },
    subscribeLibrary: (notify: () => void) => {
      listener = notify;
      return () => {
        listener = undefined;
      };
    },
    updateSettings: async (patch: Partial<DesktopSettings>) => {
      library = { ...library, settings: { ...library.settings, ...patch } };
      listener?.();
      return library.settings;
    },
  };
  const client = new DesktopLibraryClient(bridge);
  client.connect();
  return {
    client,
    bridge,
    notify: () => listener?.(),
    reads: () => reads,
    setLibrary: (next: DesktopLibrary) => {
      library = next;
    },
  };
}

test("settings mutations publish the saved catalog with one read despite main's notification", async () => {
  const { client, reads } = setup();
  await Promise.resolve();
  const initialReads = reads();
  const states: boolean[] = [];
  const unsubscribe = client.subscribe(() => states.push(client.getSnapshot().busy));
  await client.updateSettings({ autoCheckUpdates: false, agentThinkingVariant: "wave" });
  expect(reads() - initialReads).toBe(1);
  expect(client.getSnapshot()).toMatchObject({
    busy: false,
    error: null,
    library: { settings: { autoCheckUpdates: false, agentThinkingVariant: "wave" } },
  });
  expect(states).toContain(true);
  expect(states.at(-1)).toBe(false);
  unsubscribe();
  client.dispose();
});

test("a notification arriving during the post-mutation read is not lost", async () => {
  const { client, bridge, notify } = setup();
  await Promise.resolve();
  const stale = client.getSnapshot().library!;
  const read = deferred<DesktopLibrary>();
  const started = deferred<void>();
  const original = bridge.library;
  let once = true;
  bridge.library = async () => {
    if (once) {
      once = false;
      started.resolve();
      return read.promise;
    }
    return original();
  };
  const saving = client.updateSettings({ autoCheckUpdates: false });
  await started.promise;
  await bridge.updateSettings({ blockImages: true });
  notify();
  read.resolve(stale);
  await saving;
  expect(client.getSnapshot().library?.settings).toMatchObject({
    autoCheckUpdates: false,
    blockImages: true,
  });
  client.dispose();
});

test("a failed save reaches the form, releases busy state, and can be retried", async () => {
  const { client, bridge } = setup();
  await Promise.resolve();
  const save = bridge.updateSettings;
  bridge.updateSettings = async () => {
    throw new Error("Disk full");
  };
  await expect(client.updateSettings({ autoCheckUpdates: false })).rejects.toThrow("Disk full");
  expect(client.getSnapshot()).toMatchObject({ busy: false, error: "Disk full" });
  bridge.updateSettings = save;
  await client.updateSettings({ autoCheckUpdates: false });
  expect(client.getSnapshot()).toMatchObject({
    busy: false,
    error: null,
    library: { settings: { autoCheckUpdates: false } },
  });
  client.dispose();
});

test("overlapping reads keep the latest library and disposal rejects late delivery", async () => {
  const { client, bridge } = setup();
  await Promise.resolve();
  const initial = client.getSnapshot().library!;
  const old = deferred<DesktopLibrary>();
  bridge.library = () => old.promise;
  const oldRead = client.refresh();
  bridge.library = async () => ({
    ...initial,
    settings: { ...initial.settings, blockImages: true },
  });
  await client.refresh();
  old.resolve(initial);
  await oldRead;
  expect(client.getSnapshot().library?.settings.blockImages).toBe(true);
  const late = deferred<DesktopLibrary>();
  bridge.library = () => late.promise;
  const lateRead = client.refresh();
  client.dispose();
  late.resolve(initial);
  await lateRead;
  expect(client.getSnapshot().library?.settings.blockImages).toBe(true);
});

test("external changes still refresh an idle client", async () => {
  const { client, notify, setLibrary } = setup();
  await Promise.resolve();
  const library = client.getSnapshot().library!;
  setLibrary({ ...library, settings: { ...library.settings, skillsEnabled: false } });
  notify();
  await Promise.resolve();
  expect(client.getSnapshot().library?.settings.skillsEnabled).toBe(false);
  client.dispose();
});
