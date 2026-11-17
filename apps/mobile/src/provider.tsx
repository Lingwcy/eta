import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import Constants from "expo-constants";
import { fetch } from "expo/fetch";
import { randomUUID } from "expo-crypto";
import { BotClient } from "./bot/client.ts";
import { MobileStore } from "./bot/store.ts";
import { registerLocalePersistence, setLocale } from "./i18n/index.ts";
import {
  loadSavedLocale,
  loadUpdatePreferences,
  saveAutoCheckUpdates,
  saveDismissedUpdateVersion,
  saveSavedLocale,
  storage,
} from "./storage.ts";
import { createMobileUpdater, type MobileUpdater } from "./updater.ts";
import { createNativeUpdaterAdapter } from "./updater-native.ts";

const StoreContext = createContext<{
  store: MobileStore;
  updater: MobileUpdater;
  booting: boolean;
} | null>(null);

export function MobileProvider({ children }: { children: ReactNode }) {
  const [store] = useState(
    () => new MobileStore(storage, (connection) => new BotClient(connection, fetch), randomUUID),
  );
  const [updater] = useState(() =>
    createMobileUpdater({
      adapter: createNativeUpdaterAdapter(),
      initialVersion: Constants.expoConfig?.version ?? "0.1.0",
      onAutoCheckPersist: (enabled) => {
        void saveAutoCheckUpdates(enabled);
      },
      onDismissedVersionPersist: (version) => {
        void saveDismissedUpdateVersion(version);
      },
    }),
  );
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    let active = true;
    registerLocalePersistence(saveSavedLocale);
    void Promise.all([
      store.initialize(),
      loadSavedLocale()
        .then((saved) => {
          if (saved && active) setLocale(saved, false);
        })
        .catch(() => {}),
      loadUpdatePreferences()
        .then((prefs) => {
          if (active) updater.applyPreferences(prefs);
        })
        .catch(() => {}),
    ]).finally(() => {
      if (active) {
        setBooting(false);
        updater.start();
      }
    });
    const subscription = AppState.addEventListener("change", (state) => {
      const foreground = state === "active";
      store.setForeground(foreground);
      if (foreground) void updater.onForeground();
    });
    return () => {
      active = false;
      subscription.remove();
      updater.dispose();
      store.dispose();
    };
  }, [store, updater]);
  return (
    <StoreContext.Provider value={{ store, updater, booting }}>{children}</StoreContext.Provider>
  );
}

export function useMobile() {
  const context = useContext(StoreContext);
  if (!context) throw new Error("MobileProvider is missing");
  const state = useSyncExternalStore(
    context.store.subscribe,
    context.store.getSnapshot,
    context.store.getSnapshot,
  );
  return { store: context.store, state, booting: context.booting };
}

export function useUpdater() {
  const context = useContext(StoreContext);
  if (!context) throw new Error("MobileProvider is missing");
  const snapshot = useSyncExternalStore(
    (listener) => context.updater.subscribe(listener),
    () => context.updater.getSnapshot(),
    () => context.updater.getSnapshot(),
  );
  return { updater: context.updater, update: snapshot };
}
