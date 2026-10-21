import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { MobileCache } from "./bot/store.ts";

const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  files: new Map<string, string>(),
  secure: new Map<string, string>(),
  failWrite: false,
  failPublish: false,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => native.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      // Model the Android storage boundary: large photo bodies cannot live in a SQLite row.
      if (value.length > 512 * 1024) throw new Error("CursorWindow limit");
      if (native.failPublish) throw new Error("pointer failed");
      native.values.set(key, value);
    },
    getAllKeys: async () => [...native.values.keys()],
    multiGet: async (keys: string[]) => keys.map((key) => [key, native.values.get(key) ?? null]),
    multiRemove: async (keys: string[]) => {
      for (const key of keys) native.values.delete(key);
    },
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => native.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    native.secure.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    native.secure.delete(key);
  },
}));
vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(
      directory: { uri: string },
      readonly name: string,
    ) {
      this.uri = directory.uri + "/" + name;
    }
    write(value: string) {
      if (native.failWrite) {
        native.files.set(this.uri, value.slice(0, 20));
        throw new Error("disk full");
      }
      native.files.set(this.uri, value);
    }
    async text() {
      const value = native.files.get(this.uri);
      if (value === undefined) throw new Error("missing file");
      return value;
    }
    delete() {
      native.files.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    constructor(parent: string, name: string) {
      this.uri = parent + "/" + name;
    }
    create() {}
    get exists() {
      return [...native.files.keys()].some((key) => key.startsWith(this.uri + "/"));
    }
    list() {
      return [...native.files.keys()]
        .filter((key) => key.startsWith(this.uri + "/"))
        .map((key) => new File(this, key.slice(this.uri.length + 1)));
    }
    delete() {
      for (const file of this.list()) file.delete();
    }
  }
  return { File, Directory, Paths: { document: "file:///documents" } };
});

import { storage } from "./storage.ts";
const url = "https://bot.example";
const prefix = "eta-mobile.cache.v1:";
const cache = (data: string): MobileCache => ({
  drafts: { "workspace:w": "describe this image" },
  draftImages: { "workspace:w": [{ id: "image-1", type: "image", mimeType: "image/jpeg", data }] },
});

beforeEach(() => {
  native.values.clear();
  native.files.clear();
  native.secure.clear();
  native.failWrite = false;
  native.failPublish = false;
});

test("large photo drafts are stored in files and round-trip through a small published pointer", async () => {
  const value = cache("/9j/" + "A".repeat(9 * 1024 * 1024));
  await storage.saveCache(url, value);
  expect(await storage.cache(url)).toEqual(value);
  expect(native.values.get(prefix + url)!.length).toBeLessThan(512);
  expect([...native.files.values()][0]!.length).toBeGreaterThan(9 * 1024 * 1024);
});

test.each(["write", "publish"])(
  "failed %s preserves the previously published photo cache",
  async (phase) => {
    const previous = cache("/9j/previous");
    await storage.saveCache(url, previous);
    const pointer = native.values.get(prefix + url);
    if (phase === "write") native.failWrite = true;
    else native.failPublish = true;
    await expect(storage.saveCache(url, cache("/9j/replacement"))).rejects.toThrow(
      phase === "write" ? "disk full" : "pointer failed",
    );
    expect(native.values.get(prefix + url)).toBe(pointer);
    expect(await storage.cache(url)).toEqual(previous);
    native.failWrite = false;
    native.failPublish = false;
    await storage.saveCache(url, cache("/9j/latest"));
    expect(native.files.size).toBe(1);
    expect(await storage.cache(url)).toEqual(cache("/9j/latest"));
  },
);

test("legacy JSON remains readable and migrates on save without affecting a second Bot", async () => {
  const legacy = { drafts: { old: "unsent draft" } };
  native.values.set(prefix + url, JSON.stringify(legacy));
  expect(await storage.cache(url)).toEqual(legacy);
  await storage.saveCache("https://second", cache("/9j/second"));
  await storage.saveCache(url, cache("/9j/first"));
  expect(native.files.size).toBe(2);
  expect(await storage.cache("https://second")).toEqual(cache("/9j/second"));
  expect(await storage.cache(url)).toEqual(cache("/9j/first"));
});

test("orphan cleanup is bounded and preserves published files", async () => {
  for (let index = 0; index < 33; index++)
    native.files.set("file:///documents/eta-mobile-cache/orphan-" + index + ".json", "partial");
  await storage.saveCache(url, cache("/9j/current"));
  expect(native.files.size).toBe(18);
  expect(await storage.cache(url)).toEqual(cache("/9j/current"));
  await storage.saveCache("https://second", cache("/9j/second"));
  expect(native.files.size).toBe(3);
  expect(await storage.cache(url)).toEqual(cache("/9j/current"));
  expect(await storage.cache("https://second")).toEqual(cache("/9j/second"));
});

test("missing or corrupt cache bodies are ignored without replacing the published pointer", async () => {
  await storage.saveCache(url, cache("/9j/first"));
  const pointer = native.values.get(prefix + url);
  const path = [...native.files.keys()][0]!;
  native.files.set(path, "partial");
  expect(await storage.cache(url)).toBeUndefined();
  native.files.delete(path);
  expect(await storage.cache(url)).toBeUndefined();
  expect(native.values.get(prefix + url)).toBe(pointer);
});

test("clear removes credentials, legacy JSON, file pointers and orphan cache files only", async () => {
  await storage.saveConnection({ url, token: "token" });
  await storage.saveCache(url, cache("/9j/image"));
  native.values.set(prefix + "https://legacy", JSON.stringify({ drafts: {} }));
  native.values.set("unrelated", "keep");
  native.files.set("file:///documents/eta-mobile-cache/orphan.json", "partial");
  native.files.set("file:///documents/unrelated", "keep");
  await storage.clear();
  expect(await storage.connection()).toBeUndefined();
  expect([...native.values.entries()]).toEqual([["unrelated", "keep"]]);
  expect([...native.files.entries()]).toEqual([["file:///documents/unrelated", "keep"]]);
});
