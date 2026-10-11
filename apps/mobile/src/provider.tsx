import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import { fetch } from "expo/fetch";
import { randomUUID } from "expo-crypto";
import { BotClient } from "./bot/client.ts";
import { MobileStore } from "./bot/store.ts";
import { storage } from "./storage.ts";

const StoreContext = createContext<MobileStore | null>(null);

export function MobileProvider({ children }: { children: ReactNode }) {
  const [store] = useState(
    () => new MobileStore(storage, (connection) => new BotClient(connection, fetch), randomUUID),
  );
  useEffect(() => {
    void store.initialize();
    const subscription = AppState.addEventListener("change", (state) =>
      store.setForeground(state === "active"),
    );
    return () => {
      subscription.remove();
      store.dispose();
    };
  }, [store]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useMobile() {
  const store = useContext(StoreContext);
  if (!store) throw new Error("MobileProvider is missing");
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, state };
}
