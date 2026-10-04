import { afterEach, expect, test, vi } from "vite-plus/test";
import { BrowserClient } from "./client";
import { BrowserManager } from "../../../src/main/browser/manager.ts";
import type { BrowserPage } from "../../../src/main/browser/manager.ts";
import type { BrowserCommand, BrowserEvent, BrowserState } from "../../../src/browser/protocol.ts";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const listeners = new Set<(event: BrowserEvent) => void>();
  const pages = new Map<string, BrowserPage>();
  const manager = new BrowserManager(
    (id, changed) => {
      let url = "";
      const page: BrowserPage = {
        state: () => ({
          id,
          url,
          title: "Loaded page",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        }),
        load: async (address) => {
          url = address;
          changed();
        },
        back() {},
        forward() {},
        reload() {},
        stop() {},
        bounds() {},
        visible() {},
        close() {},
        capture: async () => `preview:${url}`,
      };
      pages.set(id, page);
      return page;
    },
    (event) => {
      for (const listener of listeners) listener(event);
    },
  );
  const bridge = {
    browser: (command: BrowserCommand) => manager.command(command),
    subscribeBrowser: (listener: (event: BrowserEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const client = new BrowserClient(bridge);
  client.connect(() => {});
  return { client, manager, pages, bridge, listeners };
}

test("invalid input is visible on a blank tab; retrying normalizes the address and clears the error", async () => {
  const { client, pages } = setup();
  expect(await client.command({ type: "create", id: "tab", url: "javascript:alert(1)" })).toBe(
    false,
  );
  expect(client.getSnapshot().tab?.error).toContain("http 和 https");
  expect(pages.size).toBe(0);
  expect(await client.command({ type: "create", id: "tab", url: "example.com" })).toBe(true);
  expect(client.getSnapshot().tab).toMatchObject({
    page: { url: "https://example.com/", title: "Loaded page" },
  });
  expect(client.getSnapshot().tab?.error).toBeUndefined();
});

test("viewport failures stay visible through passive layout commands and navigation can recover", async () => {
  const { client, pages } = setup();
  await client.command({ type: "create", id: "tab", url: "example.com" });
  pages.get("tab")!.bounds = () => {
    throw new Error("Cannot position the guest page");
  };
  const command = {
    type: "show",
    id: "tab",
    bounds: { x: 0, y: 96, width: 900, height: 600 },
  } as const;
  expect(await client.command(command)).toBe(false);
  const failed = client.getSnapshot();
  expect(failed.tab?.error).toBe("Cannot position the guest page");
  expect(await client.command(command)).toBe(false);
  expect(client.getSnapshot()).toBe(failed);
  await client.command({ type: "navigate", id: "tab", url: "example.org" });
  expect(client.getSnapshot().tab?.page?.url).toBe("https://example.org/");
  expect(client.getSnapshot().tab?.error).toBeUndefined();
});

test("an unavailable preview keeps the last image and leaves browsing usable with a diagnostic", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { client, pages } = setup();
  await client.command({ type: "create", id: "tab", url: "example.com" });
  await client.command({ type: "capture", id: "tab" });
  pages.get("tab")!.capture = async () => {
    throw new Error("Capture unavailable");
  };
  expect(await client.command({ type: "capture", id: "tab" })).toBe(true);
  expect(client.getSnapshot().tab?.page?.preview).toBe("preview:https://example.com/");
  expect(client.getSnapshot().tab?.error).toBeUndefined();
  expect(warn).toHaveBeenCalledWith("Unable to capture browser preview for tab", expect.any(Error));
  await client.command({ type: "navigate", id: "tab", url: "example.com/next" });
  expect(client.getSnapshot().tab?.page?.url).toBe("https://example.com/next");
});

test("late failures and page events cannot revive an evicted tab", async () => {
  const { client, bridge, listeners } = setup();
  await client.command({ type: "create", id: "tab", url: "example.com" });
  let reject!: (error: Error) => void;
  vi.spyOn(bridge, "browser").mockImplementationOnce(
    () =>
      new Promise<BrowserState | null>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const pending = client.command({ type: "navigate", id: "tab", url: "example.org" });
  client.retain(new Set());
  reject(new Error("Window closed"));
  expect(await pending).toBe(false);
  for (const listener of listeners)
    listener({
      type: "state",
      state: {
        id: "tab",
        url: "https://example.org/",
        title: "Late page",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    });
  expect(client.getSnapshot()).toEqual({});
});
