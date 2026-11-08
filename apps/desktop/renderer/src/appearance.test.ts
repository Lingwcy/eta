// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vite-plus/test";
import { AppearanceClient } from "./appearance";
import type { AppearanceSnapshot } from "../../src/appearance.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(initial: AppearanceSnapshot) {
  const read = deferred<AppearanceSnapshot>();
  const listeners = new Set<(snapshot: AppearanceSnapshot) => void>();
  return {
    read,
    listeners,
    bridge: {
      initialAppearance: initial,
      appearance: () => read.promise,
      subscribeAppearance(listener: (snapshot: AppearanceSnapshot) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(snapshot: AppearanceSnapshot) {
      for (const listener of listeners) listener(snapshot);
    },
  };
}
afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

test("dark boot applies synchronously; delayed reads cannot overwrite new broadcasts", async () => {
  const client = new AppearanceClient();
  const f = fixture({ preference: "dark", resolved: "dark", revision: 3 });
  const changed = vi.fn();
  const offListener = client.subscribe(changed);
  const off = client.connect(f.bridge);
  try {
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(client.getSnapshot()).toBe("dark");
    f.emit({ preference: "light", resolved: "light", revision: 5 });
    f.read.resolve({ preference: "dark", resolved: "dark", revision: 4 });
    await f.read.promise;
    expect(client.getSnapshot()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    f.emit({ preference: "dark", resolved: "dark", revision: 4 });
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    off();
    offListener();
  }
  expect(f.listeners.size).toBe(0);
});

test("disposing or replacing the owner rejects its late refresh while another client continues", async () => {
  const client = new AppearanceClient();
  const first = fixture({ preference: "system", resolved: "light", revision: 0 });
  const peer = new AppearanceClient();
  const offFirst = client.connect(first.bridge);
  const offPeer = peer.connect(first.bridge);
  const second = fixture({ preference: "dark", resolved: "dark", revision: 1 });
  const offSecond = client.connect(second.bridge);
  offFirst();
  try {
    first.emit({ preference: "light", resolved: "light", revision: 8 });
    first.read.resolve({ preference: "light", resolved: "light", revision: 9 });
    await first.read.promise;
    expect(client.getSnapshot()).toBe("dark");
    expect(peer.getSnapshot()).toBe("light");
    second.emit({ preference: "system", resolved: "light", revision: 2 });
    expect(client.getSnapshot()).toBe("light");
  } finally {
    offSecond();
    offPeer();
  }
  second.read.resolve({ preference: "dark", resolved: "dark", revision: 20 });
  await second.read.promise;
  expect(client.getSnapshot()).toBe("light");
  expect(first.listeners.size + second.listeners.size).toBe(0);
});
