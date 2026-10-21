import { afterEach, expect, test, vi } from "vite-plus/test";
import { BotClient } from "./client.ts";
import { CacheSchema, MobileStore, draftKey, MAX_IMAGE_BASE64_LENGTH } from "./store.ts";
import {
  events,
  json,
  library,
  memoryStorage,
  requestBody,
  requestUrl,
  thread,
} from "./fixtures.test-support.ts";

const connection = { url: "https://bot", token: "secret" };
const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png", name: "test.png" };
const stores: MobileStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});
function setup(
  message: (body: ReturnType<typeof requestBody>) => Response | Promise<Response>,
  beforeRequest?: (path: string) => Promise<void>,
) {
  const saved = memoryStorage();
  let id = 0;
  const store = new MobileStore(
    saved.storage,
    (value) =>
      new BotClient(value, async (url, init) => {
        const path = new URL(requestUrl(url)).pathname;
        await beforeRequest?.(path);
        if (path === "/v1/library") return json({ ...library, threads: [thread.thread] });
        if (path.endsWith("/events")) return events(init?.signal);
        if (path.endsWith("/messages")) return message(requestBody(init));
        return json(thread);
      }),
    () => "id-" + ++id,
  );
  stores.push(store);
  return { store, saved };
}
const admitted = () => json({ operationId: "operation", kind: "run", startedAt: 1 }, 202);

test("image-only input persists before admission, migrates on create, and clears after success", async () => {
  const bodies: unknown[] = [];
  const { store, saved } = setup((body) => {
    const cache = saved.caches.get(connection.url)!;
    expect(cache.pending?.images?.[0]?.data).toBe(image.data);
    expect(cache.draftImages?.["thread:thread"]?.[0]?.data).toBe(image.data);
    bodies.push(body);
    return admitted();
  });
  await store.connect(connection);
  store.addImages([image]);
  await store.send();
  expect(bodies).toEqual([{ prompt: "", requestId: "id-3", images: [image] }]);
  expect(store.getSnapshot().pending).toBeUndefined();
  expect(store.getSnapshot().draftImages).toEqual({});
});

test("unknown delivery and process restart retry the original image bytes and request identity", async () => {
  const bodies: unknown[] = [];
  let fail = true;
  const { store, saved } = setup((body) => {
    bodies.push(body);
    if (fail) throw new Error("lost reply");
    return admitted();
  });
  await store.connect(connection);
  await store.open("thread");
  store.addImages([image]);
  store.setDraft("look");
  await expect(store.send()).rejects.toThrow();
  const cache = CacheSchema.parse(saved.caches.get(connection.url));
  expect(cache.pending?.images?.[0]?.data).toBe(image.data);
  store.dispose();
  fail = false;
  const reloaded = new MobileStore(
    saved.storage,
    (value) =>
      new BotClient(value, async (url, init) => {
        const path = new URL(requestUrl(url)).pathname;
        if (path === "/v1/library") return json({ ...library, threads: [thread.thread] });
        if (path.endsWith("/events")) return events(init?.signal);
        if (path.endsWith("/messages")) {
          bodies.push(requestBody(init));
          return admitted();
        }
        return json(thread);
      }),
    () => "replacement-id",
  );
  stores.push(reloaded);
  await reloaded.connect(connection);
  await reloaded.retrySend();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(reloaded.getSnapshot().draftImages).toEqual({});
});

test("explicit rejection retains editable image draft and image removal is scoped to the current draft", async () => {
  const { store } = setup(() =>
    json({ error: { code: "InvalidInput", message: "invalid input" } }, 400),
  );
  await store.connect(connection);
  store.addImages([image]);
  const first = store.getSnapshot().draftImages[draftKey(store.getSnapshot())]![0]!;
  await expect(store.send()).rejects.toThrow("invalid input");
  expect(store.getSnapshot().pending).toBeUndefined();
  expect(store.getSnapshot().draftImages["thread:thread"]).toEqual([first]);
  store.newThread();
  store.addImages([image]);
  store.removeImage(first.id);
  expect(store.getSnapshot().draftImages["thread:thread"]).toEqual([first]);
  await store.open("thread");
  store.removeImage(first.id);
  expect(store.getSnapshot().draftImages["thread:thread"]).toEqual([]);
});

test("picker ownership rejects results after reopening the same thread or replacing credentials", async () => {
  const { store } = setup(admitted);
  await store.connect(connection);
  await store.open("thread");
  const oldView = store.captureImageDraft();
  await store.open("thread");
  oldView.add([image]);
  expect(oldView.isCurrent()).toBe(false);
  expect(store.getSnapshot().draftImages).toEqual({});
  const oldConnection = store.captureImageDraft();
  await store.connect({ ...connection, token: "replacement" });
  oldConnection.add([image]);
  expect(oldConnection.isCurrent()).toBe(false);
  const current = store.captureImageDraft();
  current.add([image]);
  expect(store.getSnapshot().draftImages[draftKey(store.getSnapshot())]).toHaveLength(1);
  store.dispose();
  expect(current.isCurrent()).toBe(false);
});

test("repeated selections enforce combined count and size without partially adding images", async () => {
  const { store } = setup(admitted);
  await store.connect(connection);
  store.addImages([image, image, image]);
  expect(() => store.addImages([image, image])).toThrow("最多添加 4 张图片");
  expect(store.getSnapshot().draftImages[draftKey(store.getSnapshot())]).toHaveLength(3);
  expect(() => store.addImages([{ ...image, data: "a".repeat(MAX_IMAGE_BASE64_LENGTH) }])).toThrow(
    "图片总大小不能超过 24 MiB",
  );
  expect(store.getSnapshot().draftImages[draftKey(store.getSnapshot())]).toHaveLength(3);
});

test("legacy caches without image fields still decode", () => {
  expect(
    CacheSchema.parse({ drafts: { "workspace:workspace": "hello" } }).draftImages,
  ).toBeUndefined();
});

test("drafts restore independently across reconnect and thread selection", async () => {
  const { store } = setup(admitted);
  await store.connect(connection);
  store.addImages([image]);
  await store.open("thread");
  store.addImages([{ ...image, name: "thread.png" }]);
  await store.reconnect();
  expect(store.getSnapshot().draftImages["workspace:workspace"]?.[0]?.name).toBe("test.png");
  expect(store.getSnapshot().draftImages["thread:thread"]?.[0]?.name).toBe("thread.png");
  store.newThread();
  expect(store.getSnapshot().draftImages[draftKey(store.getSnapshot())]?.[0]?.name).toBe(
    "test.png",
  );
});

test.each(["before reconnect", "after reconnect"])(
  "native picker result survives background/active %s without cache rollback",
  async (phase) => {
    const release = Promise.withResolvers<void>();
    let hold = false;
    let held = false;
    let opens = 0;
    const { store } = setup(admitted, async (path) => {
      if (path === "/v1/library" && hold) {
        held = true;
        await release.promise;
      }
      if (path === "/v1/threads/thread") ++opens;
    });
    try {
      await store.connect(connection);
      await store.open("thread");
      store.addImages([{ ...image, name: "retained.png" }]);
      const picker = store.captureImageDraft();
      store.setForeground(false);
      hold = true;
      store.setForeground(true);
      await vi.waitFor(() => expect(held).toBe(true));
      if (phase === "before reconnect") picker.add([image]);
      release.resolve();
      await vi.waitFor(() => {
        expect(opens).toBe(2);
        expect(store.getSnapshot().opening).toBe(false);
        expect(store.getSnapshot().status).toBe("connected");
      });
      expect(picker.isCurrent()).toBe(true);
      if (phase === "after reconnect") picker.add([image]);
      expect(store.getSnapshot().draftImages["thread:thread"]?.map((value) => value.name)).toEqual([
        "retained.png",
        "test.png",
      ]);
    } finally {
      release.resolve();
    }
  },
);

test("draft selection identity rejects ABA even after returning to the original draft", async () => {
  const { store } = setup(admitted);
  await store.connect(connection);
  await store.open("thread");
  const picker = store.captureImageDraft();
  store.newThread();
  await store.open("thread");
  picker.add([image]);
  expect(picker.isCurrent()).toBe(false);
  expect(store.getSnapshot().draftImages).toEqual({});
});
