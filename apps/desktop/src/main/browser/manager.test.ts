import { expect, test, vi } from "vite-plus/test";
import { BrowserManager } from "./manager.ts";
import type { BrowserPage } from "./manager.ts";
import type { BrowserEvent, BrowserBounds, BrowserState } from "../../browser/protocol.ts";

class Page implements BrowserPage {
  visibleState = false;
  closed = false;
  rectangle?: BrowserBounds;
  history: string[] = [];
  index = -1;
  pending?: (url: string) => Promise<void>;
  constructor(
    readonly id: string,
    private readonly changed: () => void,
  ) {}
  state(): BrowserState {
    return {
      id: this.id,
      url: this.history[this.index] ?? "",
      title: "Page",
      loading: false,
      canGoBack: this.index > 0,
      canGoForward: this.index < this.history.length - 1,
    };
  }
  load = async (url: string) => {
    this.history = [...this.history.slice(0, this.index + 1), url];
    this.index++;
    this.changed();
    await this.pending?.(url);
  };
  back() {
    this.index--;
    this.changed();
  }
  forward() {
    this.index++;
    this.changed();
  }
  reload() {
    this.changed();
  }
  stop() {
    this.changed();
  }
  bounds(value: BrowserBounds) {
    this.rectangle = value;
  }
  visible(value: boolean) {
    this.visibleState = value;
  }
  capture = async () => `preview:${this.state().url}`;
  close() {
    this.closed = true;
    this.visibleState = false;
  }
}

function setup() {
  const pages = new Map<string, Page>();
  const events: BrowserEvent[] = [];
  const manager = new BrowserManager(
    (id, changed) => {
      const page = new Page(id, changed);
      pages.set(id, page);
      return page;
    },
    (event) => events.push(event),
  );
  return { manager, pages, events };
}
const bounds = { x: 7, y: 110, width: 900, height: 600 };

test("switching native pages changes visibility without losing navigation history", async () => {
  const { manager, pages } = setup();
  await manager.command({ type: "create", id: "one", url: "example.com" });
  await manager.command({ type: "navigate", id: "one", url: "example.com/second" });
  await manager.command({ type: "create", id: "two", url: "example.org" });
  await manager.command({ type: "show", id: "one", bounds });
  await manager.command({ type: "show", id: "two", bounds });
  expect(pages.get("one")?.visibleState).toBe(false);
  expect(pages.get("two")?.visibleState).toBe(true);
  await manager.command({ type: "back", id: "one" });
  const first = await manager.command({ type: "show", id: "one", bounds });
  expect(first).toMatchObject({ url: "https://example.com/", canGoForward: true });
  expect(pages.get("one")?.rectangle).toEqual(bounds);
  expect(pages.get("two")?.visibleState).toBe(false);
});

test("hiding for an HTML overlay captures a preview; late hiding another page is harmless", async () => {
  const { manager, pages } = setup();
  await manager.command({ type: "create", id: "one", url: "example.com" });
  await manager.command({ type: "show", id: "one", bounds });
  const frozen = await manager.command({ type: "hide", id: "one" });
  expect(frozen?.preview).toBe("preview:https://example.com/");
  expect(pages.get("one")?.visibleState).toBe(false);
  await manager.command({ type: "create", id: "two", url: "example.org" });
  await manager.command({ type: "show", id: "two", bounds });
  await manager.command({ type: "hide", id: "one" });
  expect(pages.get("two")?.visibleState).toBe(true);
});

test("close destroys guest resources while dispose also closes inactive pages", async () => {
  const { manager, pages } = setup();
  await manager.command({ type: "create", id: "one", url: "example.com" });
  await manager.command({ type: "create", id: "two", url: "example.org" });
  await manager.command({ type: "close", id: "one" });
  expect(pages.get("one")?.closed).toBe(true);
  expect(await manager.command({ type: "show", id: "one", bounds })).toBeNull();
  manager.dispose();
  manager.dispose();
  expect(pages.get("two")?.closed).toBe(true);
  await expect(manager.command({ type: "create", id: "late", url: "example.net" })).rejects.toThrow(
    "关闭",
  );
});

test("invalid navigation cannot create a page or replace the current page", async () => {
  const { manager, pages } = setup();
  await expect(
    manager.command({ type: "create", id: "unsafe", url: "file:///private" }),
  ).rejects.toThrow();
  expect(pages.size).toBe(0);
  await manager.command({ type: "create", id: "one", url: "example.com" });
  await expect(
    manager.command({ type: "navigate", id: "one", url: "javascript:alert(1)" }),
  ).rejects.toThrow();
  expect(pages.get("one")?.state().url).toBe("https://example.com/");
});

test("an old load failure cannot overwrite a newer navigation or a closed page", async () => {
  const { manager, pages, events } = setup();
  await manager.command({ type: "create", id: "one", url: "example.com" });
  let fail!: (error: Error) => void;
  pages.get("one")!.pending = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  await manager.command({ type: "navigate", id: "one", url: "example.com/slow" });
  const oldFailure = fail;
  pages.get("one")!.pending = undefined;
  await manager.command({ type: "navigate", id: "one", url: "example.com/fast" });
  oldFailure(new Error("network failed"));
  await Promise.resolve();
  const newer = await manager.command({ type: "capture", id: "one" });
  expect(newer?.url).toBe("https://example.com/fast");
  expect(newer?.error).toBeUndefined();
  pages.get("one")!.pending = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  await manager.command({ type: "navigate", id: "one", url: "example.com/closing" });
  await manager.command({ type: "close", id: "one" });
  const before = events.length;
  fail(new Error("network failed"));
  await Promise.resolve();
  expect(events).toHaveLength(before);
});

const previewCases = (["hide", "capture"] as const).flatMap((first) =>
  (["hide", "capture"] as const).flatMap((second) =>
    [false, true].map((fail) => ({ first, second, fail })),
  ),
);
test.each(previewCases)(
  "newer preview owns the frame: $first/$second failure=$fail",
  async ({ first, second, fail }) => {
    const { manager, pages, events } = setup();
    const gate = Promise.withResolvers<string>();
    let pending: Promise<BrowserState | null> | undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await manager.command({ type: "create", id: "one", url: "example.com" });
      const baseline = await manager.command({ type: "capture", id: "one" });
      const page = pages.get("one")!;
      let captures = 0;
      page.capture = async () => {
        if (++captures === 1) return gate.promise;
        if (fail) throw new Error("New capture failed");
        return "new frame";
      };
      await manager.command({ type: "show", id: "one", bounds });
      pending = manager.command({ type: first, id: "one" });
      expect(captures).toBe(1);
      await manager.command({ type: "show", id: "one", bounds });
      const latest = await manager.command({ type: second, id: "one" });
      expect(latest?.preview).toBe(fail ? baseline?.preview : "new frame");
      gate.resolve("old frame");
      const settled = await pending;
      expect(settled?.preview).toBe(latest?.preview);
      const state = events.filter((event) => event.type === "state").at(-1);
      expect(state?.state.preview).toBe(latest?.preview);
      expect(page.closed).toBe(false);
      if (fail) expect(warn).toHaveBeenCalledOnce();
    } finally {
      gate.resolve("old frame");
      await pending;
      manager.dispose();
      warn.mockRestore();
    }
  },
);

test.each(
  (["hide", "capture"] as const).flatMap((first) =>
    (["live", "other-page", "closed"] as const).map((mode) => ({ first, mode })),
  ),
)("preview capture controls: $first/$mode", async ({ first, mode }) => {
  const { manager, pages } = setup();
  const gate = Promise.withResolvers<string>();
  let pending: Promise<BrowserState | null> | undefined;
  try {
    await manager.command({ type: "create", id: "one", url: "example.com" });
    const page = pages.get("one")!;
    page.capture = () => gate.promise;
    await manager.command({ type: "show", id: "one", bounds });
    pending = manager.command({ type: first, id: "one" });
    if (mode === "closed") await manager.command({ type: "close", id: "one" });
    if (mode === "other-page") {
      await manager.command({ type: "create", id: "two", url: "example.org" });
      await manager.command({ type: "capture", id: "two" });
    }
    gate.resolve("current frame");
    const result = await pending;
    if (mode === "closed") expect(result).toBeNull();
    else expect(result?.preview).toBe("current frame");
  } finally {
    gate.resolve("current frame");
    await pending;
    manager.dispose();
  }
});

test.each(["back", "forward", "reload"] as const)(
  "an old address failure cannot overwrite a newer %s navigation",
  async (type) => {
    const { manager, pages, events } = setup();
    const gate = Promise.withResolvers<void>();
    try {
      await manager.command({ type: "create", id: "one", url: "example.com/first" });
      await manager.command({ type: "navigate", id: "one", url: "example.com/second" });
      const page = pages.get("one")!;
      page.pending = () => gate.promise;
      await manager.command({ type: "navigate", id: "one", url: "example.com/pending" });
      if (type === "forward") await manager.command({ type: "back", id: "one" });
      const current = await manager.command({ type, id: "one" });
      gate.reject(new Error("Old address failed"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const result = await manager.command({ type: "capture", id: "one" });
      expect(result?.url).toBe(current?.url);
      expect(result?.error).toBeUndefined();
      expect(events.filter((event) => event.type === "state").at(-1)?.state.error).toBeUndefined();
    } finally {
      gate.resolve();
      manager.dispose();
    }
  },
);

test.each(["back", "forward"] as const)(
  "unavailable %s preserves the current load failure",
  async (type) => {
    const { manager, pages } = setup();
    try {
      await manager.command({ type: "create", id: "one", url: "example.com" });
      const page = pages.get("one")!;
      page.pending = async () => {
        throw new Error("Current address failed");
      };
      await manager.command({ type: "navigate", id: "one", url: "missing.example.com" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      vi.spyOn(page, "state").mockImplementation(() => ({
        id: "one",
        url: "https://missing.example.com/",
        title: "Failed",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      }));
      const result = await manager.command({ type, id: "one" });
      expect(result?.error).toBeTruthy();
    } finally {
      manager.dispose();
    }
  },
);
