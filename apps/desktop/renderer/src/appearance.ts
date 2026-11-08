import { useSyncExternalStore } from "react";
import type { AppearanceSnapshot } from "../../src/appearance.ts";
import type { DesktopBridge } from "../../src/bridge.ts";

type AppearanceBridge = Pick<
  DesktopBridge,
  "initialAppearance" | "appearance" | "subscribeAppearance"
>;

/** Theme-only subscriptions never reload the library or remount conversation state. */
export class AppearanceClient {
  private current: AppearanceSnapshot = { preference: "system", resolved: "light", revision: -1 };
  private listeners = new Set<() => void>();
  private owner?: object;
  getSnapshot = () => this.current.resolved;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  connect(bridge: AppearanceBridge) {
    const owner = {};
    this.owner = owner;
    this.current = { ...bridge.initialAppearance };
    this.apply();
    const accept = (snapshot: AppearanceSnapshot) => {
      if (this.owner !== owner || snapshot.revision <= this.current.revision) return;
      this.current = { ...snapshot };
      this.apply();
    };
    const off = bridge.subscribeAppearance(accept);
    // Subscribe before reading: an old reply cannot roll back a newer broadcast.
    void bridge.appearance().then(accept, (error: unknown) => {
      if (this.owner === owner) console.error("Eta appearance refresh failed", error);
    });
    return () => {
      off();
      if (this.owner === owner) this.owner = undefined;
    };
  }
  private apply() {
    document.documentElement.dataset.theme = this.current.resolved;
    for (const listener of this.listeners) listener();
  }
}

export const appearance = new AppearanceClient();
export function useResolvedTheme() {
  return useSyncExternalStore(appearance.subscribe, appearance.getSnapshot, appearance.getSnapshot);
}
