import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { z } from "zod";
import { ConnectionSchema } from "./bot/contracts.ts";
import { CacheSchema } from "./bot/store.ts";
import type { MobileStorage } from "./bot/store.ts";

const connectionKey = "eta-mobile.connection.v1";
const cachePrefix = "eta-mobile.cache.v1:";
const cacheDirectory = new Directory(Paths.document, "eta-mobile-cache");
const ManifestSchema = z.object({
  format: z.literal("eta-mobile-file-v1"),
  file: z.string().regex(/^[a-z0-9-]+\.json$/),
});
let sequence = 0;

/** Cache bodies include base64 photos, exceeding both Android SQLite row and database limits. */
async function cleanUnusedFiles() {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(cachePrefix));
  const pointers = await AsyncStorage.multiGet(keys);
  const retained = new Set<string>();
  for (const [, value] of pointers) {
    if (!value) continue;
    try {
      const parsed = ManifestSchema.safeParse(JSON.parse(value));
      if (parsed.success) retained.add(parsed.data.file);
    } catch {
      // Legacy or corrupt entries do not refer to a cache file.
    }
  }
  // Include leftovers from a process death before pointer publication, but bound each sweep.
  let removed = 0;
  for (const entry of cacheDirectory.list()) {
    if (entry instanceof File && !retained.has(entry.name)) {
      entry.delete();
      if (++removed >= 16) break;
    }
  }
}

export const storage: MobileStorage = {
  async connection() {
    const value = await SecureStore.getItemAsync(connectionKey);
    if (!value) return;
    return ConnectionSchema.parse(JSON.parse(value));
  },
  async saveConnection(value) {
    if (value) await SecureStore.setItemAsync(connectionKey, JSON.stringify(value));
    else await SecureStore.deleteItemAsync(connectionKey);
  },
  async cache(url) {
    const value = await AsyncStorage.getItem(cachePrefix + url);
    if (!value) return;
    try {
      let decoded: unknown = JSON.parse(value);
      const manifest = ManifestSchema.safeParse(decoded);
      if (manifest.success)
        decoded = JSON.parse(await new File(cacheDirectory, manifest.data.file).text());
      const parsed = CacheSchema.safeParse(decoded);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return;
    }
  },
  async saveCache(url, value) {
    cacheDirectory.create({ idempotent: true, intermediates: true });
    const name =
      Date.now().toString(36) +
      "-" +
      (++sequence).toString(36) +
      "-" +
      Math.random().toString(36).slice(2) +
      ".json";
    const file = new File(cacheDirectory, name);
    // MobileStore serializes storage writes. Never overwrite the currently published file.
    file.write(JSON.stringify(value));
    await AsyncStorage.setItem(
      cachePrefix + url,
      JSON.stringify({
        format: "eta-mobile-file-v1",
        file: name,
      }),
    );
    // Failed saves can leave an orphan, but cannot corrupt the previous pointer or cache body.
    // Cleanup must not turn an already committed save into an admission-blocking failure.
    await cleanUnusedFiles().catch(() => {});
  },
  async clear() {
    await SecureStore.deleteItemAsync(connectionKey);
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(cachePrefix));
    await AsyncStorage.multiRemove(keys);
    if (cacheDirectory.exists) cacheDirectory.delete();
  },
};
