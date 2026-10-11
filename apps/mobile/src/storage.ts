import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { ConnectionSchema } from "./bot/contracts.ts";
import { CacheSchema } from "./bot/store.ts";
import type { MobileStorage } from "./bot/store.ts";

const connectionKey = "eta-mobile.connection.v1";
const cachePrefix = "eta-mobile.cache.v1:";

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
      const parsed = CacheSchema.safeParse(JSON.parse(value));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return;
    }
  },
  async saveCache(url, value) {
    await AsyncStorage.setItem(cachePrefix + url, JSON.stringify(value));
  },
  async clear() {
    await SecureStore.deleteItemAsync(connectionKey);
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(cachePrefix));
    await AsyncStorage.multiRemove(keys);
  },
};
