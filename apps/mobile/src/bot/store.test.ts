import { afterEach, expect, test, vi } from "vite-plus/test";
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

test.each([false, true])(
  "an older disconnect cannot cancel a later connection after forget (sameUrl=%s)",
  async (sameUrl) => {
    const requests: { url: string; authorization: string | null }[] = [];
    const { store, saved } = setup(async (url, init) => {
      requests.push({
        url: requestUrl(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return json(library);
    });
    await store.connect(connection);
    const release = Promise.withResolvers<void>();
    const save = saved.storage.saveCache.bind(saved.storage);
    let flushing = false;
    saved.storage.saveCache = async (url, cache) => {
      flushing = true;
      await release.promise;
      await save(url, cache);
    };
    const disconnecting = store.disconnect();
    let forgetting: Promise<void> | undefined;
    let connecting: Promise<void> | undefined;
    const next = { url: sameUrl ? connection.url : "https://second-bot", token: "second-token" };
    const expected = { url: next.url + "/v1/library", authorization: "Bearer " + next.token };
    try {
      await expect.poll(() => flushing, { timeout: 1000 }).toBe(true);
      forgetting = store.disconnect(true);
      connecting = store.connect(next);
      await expect
        .poll(
          () =>
            requests.some(
              (request) =>
                request.url === expected.url && request.authorization === expected.authorization,
            ),
          { timeout: 1000 },
        )
        .toBe(true);
      release.resolve();
      await Promise.all([disconnecting, forgetting, connecting]);
      expect(store.getSnapshot()).toMatchObject({ status: "connected", url: next.url });
      expect(saved.connection()).toEqual(next);
      await store.refresh();
      expect(requests.at(-1)).toEqual(expected);
    } finally {
      release.resolve();
      await Promise.allSettled([disconnecting, forgetting, connecting]);
    }
  },
);

test("the latest overlapping connection still wins across the initial cache flush", async () => {
  const { store } = setup(async () => json(library));
  await Promise.all([
    store.connect(connection),
    store.connect({ ...connection, url: "https://second-bot" }),
  ]);
  expect(store.getSnapshot().url).toBe("https://second-bot");
});

test("forget cancels a connection still flushing its previous cache", async () => {
  vi.useFakeTimers();
  const requests: string[] = [];
  const { store, saved } = setup(async (url) => {
    requests.push(requestUrl(url));
    return json(library);
  });
  const release = Promise.withResolvers<void>();
  const work: Promise<void>[] = [];
  try {
    await store.connect(connection);
    const save = saved.storage.saveCache.bind(saved.storage);
    let held = false;
    saved.storage.saveCache = async (url, value) => {
      held = true;
      await release.promise;
      await save(url, value);
    };
    const connecting = store.connect({ ...connection, url: "https://second-bot" });
    work.push(connecting);
    void connecting.catch(() => {});
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 1000 });
    const before = requests.length;
    const forgetting = store.disconnect(true);
    work.push(forgetting);
    void forgetting.catch(() => {});
    release.resolve();
    await Promise.all(work);
    await vi.advanceTimersByTimeAsync(15000);
    expect(requests.slice(before)).toEqual([]);
    expect(store.getSnapshot().status).toBe("disconnected");
    expect(saved.connection()).toBeUndefined();
    expect(saved.caches.size).toBe(0);
  } finally {
    release.resolve();
    await Promise.allSettled(work);
    store.dispose();
    vi.useRealTimers();
  }
});

test.each(
  [
    "initialize",
    "connect",
    "connect-prior",
    "connect-open",
    "reconnect",
    "reconnect-open",
    "open",
    "send-create",
    "send-ack",
    "send-refresh",
  ].flatMap((action) => [false, true].map((disposed) => ({ action, disposed }))),
)(
  "late $action persistence respects lifecycle ownership (disposed=$disposed)",
  async ({ action, disposed }) => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const { store, saved } = setup(async (url, init) => {
      const path = new URL(requestUrl(url)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/v1/library") return json({ ...library, threads: [thread.thread] });
      if (path.endsWith("/events")) return events(init?.signal);
      if (path.endsWith("/messages"))
        return json({ operationId: "operation", kind: "run", startedAt: 1 }, 202);
      return json(thread, path === "/v1/threads" ? 201 : 200);
    }, memoryStorage(connection));
    const release = Promise.withResolvers<void>();
    const save = saved.storage.saveCache.bind(saved.storage);
    let armed = false;
    let held = false;
    let writes = 0;
    const holdAt =
      action === "send-refresh"
        ? 3
        : ["send-create", "send-ack", "connect-open", "reconnect-open"].includes(action)
          ? 2
          : 1;
    saved.storage.saveCache = async (url, value) => {
      if (armed && ++writes === holdAt) {
        held = true;
        await release.promise;
      }
      await save(url, value);
    };
    let work: Promise<void> | undefined;
    try {
      if (action === "connect-open")
        saved.caches.set(connection.url, { threadId: "thread", drafts: {} });
      if (!["initialize", "connect", "connect-open"].includes(action))
        await store.connect(connection);
      if (["send-ack", "send-refresh", "reconnect-open"].includes(action))
        await store.open("thread");
      armed = true;
      if (action.startsWith("send-")) {
        store.setDraft("Submit once");
        work = store.send();
      } else if (action === "initialize") work = store.initialize();
      else if (action.startsWith("reconnect")) work = store.reconnect();
      else if (action === "open") work = store.open("thread");
      else work = store.connect(connection);
      void work.catch(() => {});
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 1000 });
      const before = requests.length;
      if (disposed) store.dispose();
      release.resolve();
      await work;
      await vi.advanceTimersByTimeAsync(15000);
      const resumed = requests.slice(before);
      if (disposed) expect(resumed).toEqual([]);
      else
        expect(resumed).toContain(
          [
            "initialize",
            "connect",
            "connect-prior",
            "connect-open",
            "reconnect",
            "reconnect-open",
          ].includes(action)
            ? "GET /v1/library"
            : "GET /v1/threads/thread/events",
        );
      if (disposed && action === "initialize") {
        const restart = requests.length;
        await store.initialize();
        await vi.advanceTimersByTimeAsync(15000);
        expect(requests.slice(restart)).toContain("GET /v1/library");
      }
    } finally {
      release.resolve();
      await work?.catch(() => {});
      store.dispose();
      vi.useRealTimers();
    }
  },
);

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

test("forget clears credentials and every cache even when saving discarded data would fail", async () => {
  const { store, saved } = setup(async () => json(library));
  await store.connect(connection);
  saved.caches.set("https://other-bot", { drafts: { "workspace:other": "Other cached draft" } });
  store.setDraft("Discard this unsaved draft");
  saved.storage.saveCache = async () => {
    throw new Error("Cache quota exhausted");
  };
  await store.disconnect(true);
  expect(saved.connection()).toBeUndefined();
  expect(saved.caches.size).toBe(0);
  expect(store.getSnapshot()).toMatchObject({ status: "disconnected", drafts: {} });
});

test.each([false, true])(
  "forget remains ordered after an in-flight cache write (reject=%s)",
  async (reject) => {
    const { store, saved } = setup(async () => json(library));
    await store.connect(connection);
    let started = false;
    const release = Promise.withResolvers<void>();
    const save = saved.storage.saveCache.bind(saved.storage);
    let first = true;
    saved.storage.saveCache = async (url, value) => {
      if (first) {
        first = false;
        started = true;
        await release.promise;
        if (reject) throw new Error("In-flight save failed");
      }
      await save(url, value);
    };
    const writing = store.configure({
      ...store.getSnapshot().configuration!,
      thinkingLevel: "medium",
    });
    const observedWrite = writing.catch((error: unknown) => error);
    let forgetting: Promise<void> | undefined;
    try {
      await expect.poll(() => started, { timeout: 1000 }).toBe(true);
      forgetting = store.disconnect(true);
      expect(store.getSnapshot().status).toBe("disconnected");
      expect(saved.connection()).toEqual(connection);
      expect(saved.caches.size).toBeGreaterThan(0);
      release.resolve();
      await observedWrite;
      await forgetting;
      expect(saved.connection()).toBeUndefined();
      expect(saved.caches.size).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([observedWrite, forgetting]);
    }
  },
);

test("connecting while forget is clearing cannot resurrect discarded drafts", async () => {
  let validations = 0;
  const { store, saved } = setup(async () => {
    validations++;
    return json(library);
  });
  await store.connect(connection);
  saved.caches.set(connection.url, {
    drafts: { "workspace:workspace": "Discarded draft" },
    draftImages: {
      "workspace:workspace": [
        { id: "discarded-image", type: "image", mimeType: "image/png", data: "AAAA" },
      ],
    },
    pending: {
      workspaceId: "workspace",
      prompt: "Discarded pending message",
      createId: "discarded-create",
      messageId: "discarded-message",
      configuration: store.getSnapshot().configuration!,
    },
  });
  const release = Promise.withResolvers<void>();
  const clear = saved.storage.clear.bind(saved.storage);
  let clearing = false;
  saved.storage.clear = async () => {
    clearing = true;
    await release.promise;
    await clear();
  };
  const forgetting = store.disconnect(true);
  let connecting: Promise<void> | undefined;
  try {
    await expect.poll(() => clearing, { timeout: 1000 }).toBe(true);
    connecting = store.connect(connection);
    await expect.poll(() => validations, { timeout: 1000 }).toBe(2);
    release.resolve();
    await Promise.all([forgetting, connecting]);
    const { status, drafts, draftImages, pending } = store.getSnapshot();
    const cached = saved.caches.get(connection.url);
    expect({
      status,
      drafts,
      draftImages,
      pending,
      cachedDrafts: cached?.drafts,
      cachedImages: cached?.draftImages,
      cachedPending: cached?.pending,
    }).toEqual({
      status: "connected",
      drafts: {},
      draftImages: {},
      pending: undefined,
      cachedDrafts: {},
      cachedImages: {},
      cachedPending: undefined,
    });
  } finally {
    release.resolve();
    await Promise.allSettled([forgetting, connecting]);
  }
});

test("initialization cannot restore credentials or drafts while forget is clearing", async () => {
  const { store, saved } = setup(async () => json(library));
  await store.connect(connection);
  store.setDraft("Discard this saved draft");
  await store.configure(store.getSnapshot().configuration!);
  const release = Promise.withResolvers<void>();
  const clear = saved.storage.clear.bind(saved.storage);
  let clearing = false;
  saved.storage.clear = async () => {
    clearing = true;
    await release.promise;
    await clear();
  };
  const forgetting = store.disconnect(true);
  let initializing: Promise<void> | undefined;
  try {
    await expect.poll(() => clearing, { timeout: 1000 }).toBe(true);
    initializing = store.initialize();
    // Let already-resolved adapter reads run, without releasing the pending deletion.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    release.resolve();
    await Promise.all([forgetting, initializing]);
    const { status, url, drafts } = store.getSnapshot();
    expect({ status, url, drafts }).toEqual({ status: "disconnected", url: undefined, drafts: {} });
    expect(saved.connection()).toBeUndefined();
    expect(saved.caches.size).toBe(0);
  } finally {
    release.resolve();
    await Promise.allSettled([forgetting, initializing]);
  }
});

test("forget queues removal before a subscriber can restart initialization", async () => {
  const { store, saved } = setup(async () => json(library));
  await store.connect(connection);
  let initializing: Promise<void> | undefined;
  const unsubscribe = store.subscribe(() => {
    if (store.getSnapshot().status !== "disconnected") return;
    unsubscribe();
    initializing = store.initialize();
  });
  try {
    await store.disconnect(true);
    await initializing;
    const { status, url } = store.getSnapshot();
    expect({ status, url }).toEqual({ status: "disconnected", url: undefined });
    expect(saved.connection()).toBeUndefined();
    expect(saved.caches.size).toBe(0);
  } finally {
    unsubscribe();
    await initializing;
  }
});

test("a rejected clear is reported and can be retried instead of claiming data was erased", async () => {
  const { store, saved } = setup(async () => json(library));
  await store.connect(connection);
  const clear = saved.storage.clear.bind(saved.storage);
  let reject = true;
  saved.storage.clear = async () => {
    if (reject) throw new Error("Secure storage deletion rejected");
    await clear();
  };
  await expect(store.disconnect(true)).rejects.toThrow("Secure storage deletion rejected");
  expect(saved.connection()).toEqual(connection);
  expect(saved.caches.size).toBeGreaterThan(0);
  reject = false;
  await store.disconnect(true);
  expect(saved.connection()).toBeUndefined();
  expect(saved.caches.size).toBe(0);
});

test("ordinary disconnect still preserves drafts and reports a failed final save", async () => {
  const { store, saved } = setup(async () => json(library));
  await store.connect(connection);
  store.setDraft("Preserve this unsaved draft");
  const save = saved.storage.saveCache.bind(saved.storage);
  saved.storage.saveCache = async () => {
    throw new Error("Cache quota exhausted");
  };
  await expect(store.disconnect()).rejects.toThrow("Cache quota exhausted");
  expect(saved.connection()).toEqual(connection);
  expect(store.getSnapshot().status).toBe("connected");
  saved.storage.saveCache = save;
  await store.disconnect();
  expect(saved.connection()).toBeUndefined();
  expect(saved.caches.get(connection.url)?.drafts["workspace:workspace"]).toBe(
    "Preserve this unsaved draft",
  );
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

test.each([
  { stage: "cache-load", prior: true, tokenOnly: false },
  { stage: "credential-save", prior: true, tokenOnly: false },
  { stage: "cache-save", prior: true, tokenOnly: false },
  { stage: "cache-save", prior: false, tokenOnly: false },
  { stage: "cache-save", prior: true, tokenOnly: true },
])(
  "connection and next admission stay on the committed Bot after $stage failure (prior=$prior, tokenOnly=$tokenOnly)",
  async ({ stage, prior, tokenOnly }) => {
    const saved = memoryStorage();
    const second = {
      url: tokenOnly ? connection.url : "https://second-bot",
      token: "second-token",
    };
    let acceptedToken = connection.token;
    let credentialsSaved = false;
    const admitted: { host: string; authorization: string | null; prompt: unknown }[] = [];
    const created = new Set<string>();
    const { store } = setup(async (url, init) => {
      const parsed = new URL(requestUrl(url));
      const token = parsed.hostname === "second-bot" ? second.token : acceptedToken;
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${token}`)
        return json({ error: { code: "Unauthorized", message: "Token revoked" } }, 401);
      if (parsed.pathname === "/v1/library")
        return json({
          ...library,
          projects: [{ ...library.projects[0]!, name: parsed.hostname }],
          threads: created.has(parsed.hostname) ? [thread.thread] : [],
        });
      if (parsed.pathname.endsWith("/events")) return events(init?.signal);
      if (parsed.pathname === "/v1/threads") {
        created.add(parsed.hostname);
        return json(thread, 201);
      }
      if (parsed.pathname.endsWith("/messages")) {
        admitted.push({
          host: parsed.hostname,
          authorization: new Headers(init?.headers).get("authorization"),
          prompt: requestBody(init).prompt,
        });
        return json({ operationId: "operation", kind: "run", startedAt: 1 }, 202);
      }
      return json(thread);
    }, saved);
    if (prior) await store.connect(connection);
    if (tokenOnly) acceptedToken = second.token;
    const cache = saved.storage.cache.bind(saved.storage);
    const saveConnection = saved.storage.saveConnection.bind(saved.storage);
    const saveCache = saved.storage.saveCache.bind(saved.storage);
    let fail = true;
    saved.storage.cache = async (url) => {
      if (stage === "cache-load" && url === second.url && fail) {
        fail = false;
        throw new Error("Simulated storage failure");
      }
      return cache(url);
    };
    saved.storage.saveConnection = async (value) => {
      if (stage === "credential-save" && value?.url === second.url && fail) {
        fail = false;
        throw new Error("Simulated storage failure");
      }
      await saveConnection(value);
      if (value?.token === second.token) credentialsSaved = true;
    };
    saved.storage.saveCache = async (url, value) => {
      if (stage === "cache-save" && credentialsSaved && url === second.url && fail) {
        fail = false;
        throw new Error("Simulated storage failure");
      }
      return saveCache(url, value);
    };
    await expect(store.connect(second)).rejects.toThrow("Simulated storage failure");
    await store.refresh();
    const refreshed = store.getSnapshot();
    const expected = stage === "cache-save" ? second : connection;
    const host = new URL(expected.url).hostname;
    store.setDraft("Only the selected Bot should receive this prompt");
    await store.send();
    expect({
      url: refreshed.url,
      project: refreshed.library?.projects[0]?.name,
      credentials: saved.connection(),
      cache: saved.caches.get(expected.url)?.library?.projects[0]?.name,
      admitted,
    }).toEqual({
      url: expected.url,
      project: host,
      credentials: expected,
      cache: host,
      admitted: [
        {
          host,
          authorization: `Bearer ${expected.token}`,
          prompt: "Only the selected Bot should receive this prompt",
        },
      ],
    });
  },
);

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

test("chosen model configuration is remembered across new threads and restarts", async () => {
  const saved = memoryStorage();
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    if (path === "/v1/library") return json(library);
    if (path.endsWith("/events")) return events(init?.signal);
    return json(thread);
  };
  const first = setup(fetcher, saved).store;
  await first.connect(connection);
  const customConfig = {
    provider: "test",
    modelId: "one",
    thinkingLevel: "high" as const,
    sandboxMode: "read-only" as const,
  };
  await first.configure(customConfig);
  expect(first.getSnapshot().configuration).toEqual(customConfig);

  // New thread keeps the chosen configuration
  first.newThread();
  expect(first.getSnapshot().configuration).toEqual(customConfig);

  // Restarting with cache preserves the chosen configuration
  const restarted = setup(fetcher, saved).store;
  await restarted.initialize();
  expect(restarted.getSnapshot().configuration).toEqual(customConfig);
});

test("Mobile streaming submission persists mode through an unknown-response retry", async () => {
  const active = structuredClone(thread);
  active.snapshot.inputQueueSupported = true;
  active.snapshot.operation = { id: "root", status: "running", runningTools: [] };
  const sent: Record<string, unknown>[] = [];
  let fail = true;
  const { store, saved } = setup(async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    if (path.endsWith("/messages")) {
      sent.push(requestBody(init));
      if (fail) {
        fail = false;
        throw new Error("Connection lost");
      }
      return json({ operationId: "queued", kind: "run", startedAt: 2, status: "queued" }, 202);
    }
    if (path.endsWith("/events")) return events(init?.signal);
    return json(path === "/v1/library" ? library : active);
  });
  await store.connect(connection);
  await store.open(thread.id);
  store.setDraft("do afterwards");
  await expect(store.send("followUp")).rejects.toThrow("无法连接 Bot");
  expect(saved.caches.get(connection.url)?.pending?.whenBusy).toBe("followUp");
  expect(store.getSnapshot().drafts[draftKey(store.getSnapshot())]).toBe("do afterwards");
  await store.retrySend();
  expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject({ prompt: "do afterwards", whenBusy: "followUp" });
  expect(sent[1]).toEqual(sent[0]);
  expect(store.getSnapshot().pending).toBeUndefined();
  expect(store.getSnapshot().drafts[draftKey(store.getSnapshot())]).toBeUndefined();
});

test("Mobile does not downgrade a busy submission on a Bot without queue support", async () => {
  const active = structuredClone(thread);
  active.snapshot.operation = { id: "root", status: "running", runningTools: [] };
  let sends = 0;
  const { store } = setup(async (url, init) => {
    const path = new URL(requestUrl(url)).pathname;
    if (path.endsWith("/messages")) sends++;
    if (path.endsWith("/events")) return events(init?.signal);
    return json(path === "/v1/library" ? library : active);
  });
  await store.connect(connection);
  await store.open(thread.id);
  store.setDraft("keep this draft");
  await expect(store.send()).rejects.toThrow("不支持运行中发送");
  expect(sends).toBe(0);
  expect(store.getSnapshot().drafts[draftKey(store.getSnapshot())]).toBe("keep this draft");
});

test.each([false, true])(
  "Mobile withdrawal keeps current draft ownership across awaits (switch=%s)",
  async (switchView) => {
    const response = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    const { store } = setup(async (url, init) => {
      const path = new URL(requestUrl(url)).pathname;
      if (path.endsWith("/inputs/withdraw")) {
        entered.resolve();
        return response.promise;
      }
      if (path.endsWith("/events")) return events(init?.signal);
      return json(path === "/v1/library" ? library : thread);
    });
    await store.connect(connection);
    await store.open(thread.id);
    store.setDraft("earlier draft");
    const restoring = store.restoreInput("42");
    try {
      await entered.promise;
      if (switchView) store.newThread("workspace");
      store.setDraft("newer draft");
      response.resolve(
        json({
          status: "withdrawn",
          prompt: "recovered",
          images: [{ type: "image", data: "AA==", mimeType: "image/png", name: "saved.png" }],
        }),
      );
      expect(await restoring).toBe(!switchView);
      const state = store.getSnapshot();
      expect(state.drafts[draftKey(state)]).toBe(
        switchView ? "newer draft" : "newer draft\n\nrecovered",
      );
      expect(state.draftImages[draftKey(state)]?.length ?? 0).toBe(switchView ? 0 : 1);
    } finally {
      response.resolve(json({ status: "settled" }));
      await restoring;
    }
  },
);
