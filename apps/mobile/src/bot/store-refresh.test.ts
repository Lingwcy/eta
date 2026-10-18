import { expect, test } from "vite-plus/test";
import { BotClient } from "./client.ts";
import { MobileStore } from "./store.ts";
import {
  events,
  json,
  library,
  memoryStorage,
  requestUrl,
  thread,
} from "./fixtures.test-support.ts";

const connection = { url: "https://bot", token: "secret" };
function replacement(
  sameUrl: boolean,
  outcome: "success" | "unauthorized" | "cache-failure" = "success",
) {
  const next = { url: sameUrl ? connection.url : "https://second-bot", token: "second" };
  const candidate = Promise.withResolvers<void>();
  const old = Promise.withResolvers<void>();
  const current = Promise.withResolvers<void>();
  const pending: Promise<void>[] = [];
  const saved = memoryStorage();
  let candidateEntered = false;
  let oldEntered = false;
  let holdOld = false;
  let holdCurrent = false;
  let oldRequests = 0;
  let currentRequests = 0;
  let aborted = 0;
  const store = new MobileStore(
    saved.storage,
    (credentials) =>
      new BotClient(credentials, async (url, init) => {
        const isCurrent = new Headers(init?.headers).get("authorization") === "Bearer second";
        const path = new URL(requestUrl(url)).pathname;
        if (path === "/v1/library") {
          if (isCurrent) {
            ++currentRequests;
            if (currentRequests === 1) {
              candidateEntered = true;
              await candidate.promise;
            } else if (holdCurrent) await current.promise;
          } else {
            ++oldRequests;
            if (holdOld) {
              oldEntered = true;
              await old.promise;
              if (outcome === "unauthorized")
                return json({ error: { code: "Unauthorized", message: "Old token revoked" } }, 401);
            }
          }
          return json({
            ...library,
            threads: [thread.thread],
            projects: [{ ...library.projects[0]!, name: isCurrent ? "Current" : "Old" }],
          });
        }
        if (path.endsWith("/events")) {
          if (isCurrent) init?.signal?.addEventListener("abort", () => ++aborted, { once: true });
          return events(init?.signal);
        }
        return json(thread);
      }),
    () => "unused-id",
  );
  const track = (work: Promise<void>) => {
    pending.push(work);
    void work.catch(() => {});
    return work;
  };
  const coalesce = async () => {
    let settled = false;
    const work = track(
      store.refresh().finally(() => {
        settled = true;
      }),
    );
    await expect.poll(() => settled, { timeout: 1000 }).toBe(true);
    await work;
  };
  return {
    coalesce,
    store,
    saved,
    next,
    old,
    current,
    counts: () => ({ oldRequests, currentRequests, aborted }),
    holdCurrent: () => {
      holdCurrent = true;
    },
    track,
    async begin({ settleOldBeforeCommit = false, openCurrent = true } = {}) {
      await store.connect(connection);
      const connecting = track(store.connect(next));
      await expect.poll(() => candidateEntered, { timeout: 1000 }).toBe(true);
      holdOld = true;
      const refreshing = track(store.refresh());
      await expect.poll(() => oldEntered, { timeout: 1000 }).toBe(true);
      await coalesce();
      expect(oldRequests).toBe(2);
      if (settleOldBeforeCommit) {
        old.resolve();
        await refreshing;
      }
      candidate.resolve();
      await connecting;
      if (openCurrent) await store.open("thread");
      return { refreshing };
    },
    async close() {
      candidate.resolve();
      old.resolve();
      current.resolve();
      await Promise.allSettled(pending);
      store.dispose();
    },
  };
}

test.each(
  [false, true].flatMap((sameUrl) =>
    (["success", "unauthorized", "cache-failure"] as const).map((outcome) => ({
      sameUrl,
      outcome,
    })),
  ),
)(
  "old refresh cannot mutate a replacement (sameUrl=$sameUrl, outcome=$outcome)",
  async ({ sameUrl, outcome }) => {
    const race = replacement(sameUrl, outcome);
    try {
      const { refreshing } = await race.begin();
      if (outcome === "cache-failure")
        race.saved.storage.saveCache = async () => {
          throw new Error("Stale cache write");
        };
      race.old.resolve();
      await refreshing;
      expect(race.counts().aborted).toBe(0);
      expect(race.store.getSnapshot()).toMatchObject({
        status: "connected",
        error: undefined,
        url: race.next.url,
      });
      expect(race.store.getSnapshot().library?.projects[0]?.name).toBe("Current");
      expect(race.saved.caches.get(race.next.url)?.library?.projects[0]?.name).toBe("Current");
    } finally {
      await race.close();
    }
  },
);

test.each([false, true])(
  "refresh coalescing belongs to the active client (sameUrl=%s)",
  async (sameUrl) => {
    const race = replacement(sameUrl);
    try {
      const { refreshing: previous } = await race.begin();
      race.holdCurrent();
      const refreshing = race.track(race.store.refresh());
      await expect.poll(() => race.counts().currentRequests, { timeout: 1000 }).toBe(2);
      await race.coalesce();
      expect(race.counts().currentRequests).toBe(2);
      race.old.resolve();
      await previous;
      await race.coalesce();
      expect(race.counts().currentRequests).toBe(2);
      race.current.resolve();
      await refreshing;
      await race.store.refresh();
      expect(race.counts().currentRequests).toBe(3);
      expect(race.store.getSnapshot().library?.projects[0]?.name).toBe("Current");
    } finally {
      await race.close();
    }
  },
);

test.each(["unauthorized", "cache-failure"])(
  "current refresh still reports %s",
  async (outcome) => {
    const saved = memoryStorage();
    const save = saved.storage.saveCache.bind(saved.storage);
    let fail = false;
    let aborted = 0;
    const store = new MobileStore(
      saved.storage,
      (credentials) =>
        new BotClient(credentials, async (url, init) => {
          const path = new URL(requestUrl(url)).pathname;
          if (path === "/v1/library") {
            if (fail && outcome === "unauthorized") return json({}, 401);
            return json({ ...library, threads: [thread.thread] });
          }
          if (path.endsWith("/events")) {
            init?.signal?.addEventListener("abort", () => ++aborted, { once: true });
            return events(init?.signal);
          }
          return json(thread);
        }),
      () => "unused-id",
    );
    try {
      await store.connect(connection);
      await store.open("thread");
      fail = true;
      if (outcome === "cache-failure")
        saved.storage.saveCache = async () => {
          throw new Error("Current cache write failed");
        };
      await store.refresh();
      expect(store.getSnapshot().status).toBe("error");
      expect(store.getSnapshot().error).toBeTruthy();
      expect(aborted).toBe(outcome === "unauthorized" ? 1 : 0);
      fail = false;
      saved.storage.saveCache = save;
      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({ status: "connected", error: undefined });
    } finally {
      store.dispose();
    }
  },
);

test("a queued old cache write is skipped at the committed replacement", async () => {
  const saved = memoryStorage();
  const next = { url: "https://second-bot", token: "second" };
  const release = Promise.withResolvers<void>();
  const work: Promise<void>[] = [];
  let credentialsEntered = false;
  let refreshOld = false;
  let stateAtFailure: string | undefined;
  const store = new MobileStore(
    saved.storage,
    (credentials) =>
      new BotClient(credentials, async (_url, init) => {
        const current = new Headers(init?.headers).get("authorization") === "Bearer second";
        return json({
          ...library,
          projects: [
            {
              ...library.projects[0]!,
              name: current ? "Current" : refreshOld ? "Late old" : "Initial",
            },
          ],
        });
      }),
    () => "unused-id",
  );
  const saveConnection = saved.storage.saveConnection.bind(saved.storage);
  saved.storage.saveConnection = async (value) => {
    if (value?.token === next.token) {
      credentialsEntered = true;
      await release.promise;
    }
    await saveConnection(value);
  };
  const saveCache = saved.storage.saveCache.bind(saved.storage);
  saved.storage.saveCache = async (url, cache) => {
    if (cache.library?.projects[0]?.name === "Late old") {
      stateAtFailure = store.getSnapshot().library?.projects[0]?.name;
      throw new Error("Old cache write failed");
    }
    await saveCache(url, cache);
  };
  try {
    await store.connect(connection);
    const connecting = store.connect(next);
    work.push(connecting);
    void connecting.catch(() => {});
    await expect.poll(() => credentialsEntered, { timeout: 1000 }).toBe(true);
    refreshOld = true;
    const refreshing = store.refresh();
    work.push(refreshing);
    void refreshing.catch(() => {});
    await expect
      .poll(() => store.getSnapshot().library?.projects[0]?.name, { timeout: 1000 })
      .toBe("Late old");
    release.resolve();
    await Promise.all(work);
    expect(stateAtFailure).toBeUndefined();
    expect(store.getSnapshot()).toMatchObject({
      status: "connected",
      url: next.url,
      error: undefined,
    });
    expect(saved.caches.get(next.url)?.library?.projects[0]?.name).toBe("Current");
  } finally {
    release.resolve();
    await Promise.allSettled(work);
    store.dispose();
  }
});

test.each(
  ["open", "metadata"].flatMap((action) => [false, true].map((handoff) => ({ action, handoff }))),
)(
  "validation-window $action result belongs to its active client (handoff=$handoff)",
  async ({ action, handoff }) => {
    const saved = memoryStorage();
    const candidate = Promise.withResolvers<void>();
    const old = Promise.withResolvers<void>();
    const work: Promise<void>[] = [];
    let candidateEntered = false;
    let operationEntered = false;
    let oldAborted = 0;
    const store = new MobileStore(
      saved.storage,
      (credentials) =>
        new BotClient(credentials, async (url, init) => {
          const current = new Headers(init?.headers).get("authorization") === "Bearer second";
          const path = new URL(requestUrl(url)).pathname;
          if (path === "/v1/library") {
            if (current) {
              candidateEntered = true;
              await candidate.promise;
            }
            return json({
              ...library,
              threads: [{ ...thread.thread, title: current ? "Current" : "Initial" }],
            });
          }
          if (path.endsWith("/events")) {
            if (!current)
              init?.signal?.addEventListener("abort", () => ++oldAborted, { once: true });
            return events(init?.signal);
          }
          if (!current) {
            operationEntered = true;
            await old.promise;
          }
          const metadata = { ...thread.thread, title: current ? "Current" : "Old read" };
          return json(path.endsWith("/metadata") ? metadata : { ...thread, thread: metadata });
        }),
      () => "unused-id",
    );
    try {
      await store.connect(connection);
      const connecting = store.connect({ url: "https://second-bot", token: "second" });
      work.push(connecting);
      void connecting.catch(() => {});
      await expect.poll(() => candidateEntered, { timeout: 1000 }).toBe(true);
      await store.refresh();
      const operation =
        action === "open" ? store.open("thread") : store.metadata("thread", { title: "Old read" });
      work.push(operation);
      void operation.catch(() => {});
      await expect.poll(() => operationEntered, { timeout: 1000 }).toBe(true);
      if (handoff) {
        candidate.resolve();
        await connecting;
      }
      old.resolve();
      await operation;
      if (!handoff) {
        expect(
          action === "open"
            ? store.getSnapshot().thread?.thread.title
            : store.getSnapshot().library?.threads[0]?.title,
        ).toBe("Old read");
        candidate.resolve();
        await connecting;
        if (action === "open") expect(oldAborted).toBe(1);
      }
      expect(store.getSnapshot()).toMatchObject({
        status: "connected",
        opening: false,
        error: undefined,
      });
      expect(store.getSnapshot().thread).toBeUndefined();
      expect(store.getSnapshot().library?.threads[0]?.title).toBe("Current");
      expect(saved.caches.get("https://second-bot")?.threadId).toBeUndefined();
    } finally {
      candidate.resolve();
      old.resolve();
      await Promise.allSettled(work);
      store.dispose();
    }
  },
);

test("handoff clears errors that belonged to the previously active client", async () => {
  const race = replacement(false, "unauthorized");
  try {
    await race.begin({ settleOldBeforeCommit: true, openCurrent: false });
    expect(race.store.getSnapshot()).toMatchObject({
      status: "connected",
      opening: false,
      error: undefined,
      url: race.next.url,
    });
  } finally {
    await race.close();
  }
});
