import { afterEach, expect, test } from "vite-plus/test";
import { BotClient } from "./client.ts";
import { MobileStore, draftKey } from "./store.ts";
import {
  events,
  json,
  library,
  memoryStorage,
  thread,
  requestUrl,
  requestBody,
} from "./fixtures.test-support.ts";

const stores: MobileStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});
function setup(fetcher: typeof fetch, saved = memoryStorage()) {
  let id = 0;
  const store = new MobileStore(
    saved.storage,
    (connection) => new BotClient(connection, fetcher),
    () => `request-${++id}`,
  );
  stores.push(store);
  return { store, saved };
}
const connection = { url: "https://bot", token: "secret" };

test("a lost message response survives restart and retries the same request without duplicating work", async () => {
  const saved = memoryStorage();
  const admissions = new Set<string>();
  const creations = new Set<string>();
  let lose = true;
  let hasThread = false;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    if (path === "/v1/library")
      return json({ ...library, threads: hasThread ? [thread.thread] : [] });
    if (path.endsWith("/events")) return events(init?.signal);
    if (path === "/v1/threads") {
      const body = requestBody(init);
      creations.add(body.requestId!);
      hasThread = true;
      return json(thread, 201);
    }
    if (path.endsWith("/messages")) {
      const body = requestBody(init);
      admissions.add(body.requestId!);
      if (lose) {
        lose = false;
        throw new Error("Connection reset after admission");
      }
      return json({ operationId: "operation", kind: "run", startedAt: 1 }, 202);
    }
    return json(thread);
  };
  const first = setup(fetcher, saved).store;
  await first.connect(connection);
  first.setDraft("Do the work");
  await expect(first.send()).rejects.toThrow("无法连接 Bot");
  const pending = first.getSnapshot().pending!;
  expect(pending.threadId).toBe("thread");
  expect(saved.caches.get(connection.url)?.pending).toEqual(pending);
  expect(first.getSnapshot().drafts[draftKey(first.getSnapshot())]).toBe("Do the work");
  first.dispose();
  const restarted = setup(fetcher, saved).store;
  await restarted.initialize();
  expect(restarted.getSnapshot().pending?.messageId).toBe(pending.messageId);
  await restarted.retrySend();
  expect(admissions.size).toBe(1);
  expect(creations.size).toBe(1);
  expect(restarted.getSnapshot().pending).toBeUndefined();
  expect(restarted.getSnapshot().drafts[draftKey(restarted.getSnapshot())]).toBeUndefined();
});

test("an explicit Busy rejection keeps the prompt available to resend", async () => {
  const { store } = setup(async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    if (path === "/v1/library") return json({ ...library, threads: [thread.thread] });
    if (path.endsWith("/events")) return events(init?.signal);
    if (path.endsWith("/messages"))
      return json({ error: { code: "Busy", message: "Project busy" } }, 409);
    return json(thread);
  });
  await store.connect(connection);
  await store.open("thread");
  store.setDraft("Try later");
  await expect(store.send()).rejects.toThrow("Project busy");
  expect(store.getSnapshot().pending).toBeUndefined();
  expect(store.getSnapshot().drafts[draftKey(store.getSnapshot())]).toBe("Try later");
});

test("a lost create response reuses its durable create ID after restart", async () => {
  const saved = memoryStorage();
  const created = new Set<string>();
  let lose = true;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    if (path === "/v1/library")
      return json({ ...library, threads: created.size ? [thread.thread] : [] });
    if (path.endsWith("/events")) return events(init?.signal);
    if (path === "/v1/threads") {
      created.add(requestBody(init).requestId!);
      if (lose) {
        lose = false;
        throw new Error("Lost creation response");
      }
      return json(thread);
    }
    if (path.endsWith("/messages"))
      return json({ operationId: "operation", kind: "run", startedAt: 1 });
    return json(thread);
  };
  const first = setup(fetcher, saved).store;
  await first.connect(connection);
  first.setDraft("New thread request");
  await expect(first.send()).rejects.toThrow();
  expect(saved.caches.get(connection.url)?.pending?.threadId).toBeUndefined();
  first.dispose();
  const second = setup(fetcher, saved).store;
  await second.initialize();
  await second.retrySend();
  expect(created.size).toBe(1);
  expect(second.getSnapshot().threadId).toBe("thread");
});

test("disconnect and reconnect preserve an unresolved message for the same Bot", async () => {
  const { store, saved } = setup(async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    if (path === "/v1/library") return json({ ...library, threads: [thread.thread] });
    if (path.endsWith("/events")) return events(init?.signal);
    if (path.endsWith("/messages")) throw new Error("Lost response");
    return json(thread);
  });
  await store.connect(connection);
  await store.open("thread");
  store.setDraft("Unconfirmed input");
  await expect(store.send()).rejects.toThrow();
  const requestId = store.getSnapshot().pending?.messageId;
  await store.disconnect();
  expect(saved.connection()).toBeUndefined();
  await store.connect(connection);
  expect(store.getSnapshot().pending?.messageId).toBe(requestId);
  expect(store.getSnapshot().drafts["thread:thread"]).toBe("Unconfirmed input");
});

test("different Bots keep separate drafts, and clearing removes all phone caches", async () => {
  const { store, saved } = setup(async () => json(library));
  await store.connect(connection);
  store.setDraft("First Bot draft");
  await store.connect({ ...connection, url: "https://second-bot" });
  expect(store.getSnapshot().drafts).toEqual({});
  store.setDraft("Second Bot draft");
  await store.connect(connection);
  expect(store.getSnapshot().drafts[draftKey(store.getSnapshot())]).toBe("First Bot draft");
  await store.disconnect(true);
  expect(saved.connection()).toBeUndefined();
  expect(saved.caches.size).toBe(0);
});

test("late responses from the old Bot cannot overwrite a new connection", async () => {
  let resolveOld!: (response: Response) => void;
  let delayOld = false;
  const { store } = setup(async (url, init) => {
    const parsed = new URL(requestUrl(url));
    if (parsed.pathname.endsWith("/events")) return events(init?.signal);
    if (parsed.hostname === "bot" && delayOld)
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    return json({ ...library, projects: [{ ...library.projects[0]!, name: parsed.hostname }] });
  });
  await store.connect(connection);
  delayOld = true;
  const old = store.refresh();
  await store.connect({ url: "https://new-bot", token: "other" });
  resolveOld(json({ ...library, projects: [{ ...library.projects[0]!, name: "stale" }] }));
  await old;
  expect(store.getSnapshot().url).toBe("https://new-bot");
  expect(store.getSnapshot().library?.projects[0]?.name).toBe("new-bot");
});

test("background and disconnect cancel observation without stopping remote work", async () => {
  const calls: string[] = [];
  let aborted = 0;
  const { store } = setup(async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    calls.push(path);
    if (path === "/v1/library") return json({ ...library, threads: [thread.thread] });
    if (path.endsWith("/events")) {
      init?.signal?.addEventListener("abort", () => ++aborted, { once: true });
      return events(init?.signal);
    }
    return json(thread);
  });
  await store.connect(connection);
  await store.open("thread");
  store.setForeground(false);
  expect(aborted).toBe(1);
  store.setForeground(true);
  await expect.poll(() => calls.filter((path) => path.endsWith("/events")).length).toBe(2);
  await store.disconnect();
  expect(aborted).toBe(2);
  expect(calls.some((path) => path.endsWith("/stop"))).toBe(false);
});

test("opening a slower previous thread cannot replace the current thread", async () => {
  let resolveSlow!: (response: Response) => void;
  const second = { ...thread, id: "second", thread: { ...thread.thread, id: "second" } };
  const { store } = setup(async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    if (path === "/v1/library")
      return json({ ...library, threads: [thread.thread, second.thread] });
    if (path.endsWith("/events")) return events(init?.signal);
    if (path.endsWith("/thread"))
      return new Promise((resolve) => {
        resolveSlow = resolve;
      });
    return json(second);
  });
  await store.connect(connection);
  const slow = store.open("thread");
  await store.open("second");
  resolveSlow(json(thread));
  await slow;
  expect(store.getSnapshot().thread?.id).toBe("second");
});

test("approval, stop and resume call the Bot and refresh observable state", async () => {
  const actions: { path: string; body: unknown }[] = [];
  const { store } = setup(async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    if (path === "/v1/library") return json({ ...library, threads: [thread.thread] });
    if (path.endsWith("/events")) return events(init?.signal);
    if (init?.method === "POST") actions.push({ path, body: requestBody(init) });
    if (path.endsWith("/stop")) return json({ stopped: true });
    if (path.endsWith("/resume")) return json({ resumed: true });
    return json(thread);
  });
  await store.connect(connection);
  await store.open("thread");
  await store.approve("approval/id", false);
  await store.control("stop");
  await store.control("resume");
  expect(actions).toEqual([
    { path: "/v1/threads/thread/approvals/approval%2Fid", body: { approved: false } },
    { path: "/v1/threads/thread/stop", body: {} },
    { path: "/v1/threads/thread/resume", body: {} },
  ]);
  expect(store.getSnapshot().thread?.id).toBe("thread");
});
