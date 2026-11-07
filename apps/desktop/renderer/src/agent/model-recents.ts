import type { ThinkingLevel } from "@eta/core/agent/protocol";
import { browserStorage } from "./browser-storage";

export type RecentModel = {
  scope: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
};
const key = "eta.model-recents.v1";
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class ModelRecents {
  private entries: readonly RecentModel[];
  private listeners = new Set<() => void>();
  constructor(private storage: Pick<Storage, "getItem" | "setItem">) {
    this.entries = this.read();
  }
  private read(): RecentModel[] {
    try {
      const values: unknown = JSON.parse(this.storage.getItem(key) ?? "[]");
      if (!Array.isArray(values)) return [];
      return values
        .filter(
          (v): v is RecentModel =>
            v &&
            typeof v === "object" &&
            typeof v.scope === "string" &&
            typeof v.provider === "string" &&
            typeof v.modelId === "string" &&
            typeof v.thinkingLevel === "string" &&
            levels.has(v.thinkingLevel),
        )
        .slice(0, 100);
    } catch {
      return [];
    }
  }
  getSnapshot = () => this.entries;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  record = (entry: RecentModel) => {
    // Another renderer may have saved choices since this store loaded. Prefer durable order,
    // while retaining local choices if optional storage was unavailable.
    const seen = new Set<string>();
    this.entries = [entry, ...this.read(), ...this.entries]
      .filter((value) => {
        const identity = JSON.stringify([value.scope, value.provider, value.modelId]);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
      .slice(0, 100);
    try {
      this.storage.setItem(key, JSON.stringify(this.entries));
    } catch {
      /* Storage is optional. */
    }
    for (const listener of this.listeners) listener();
  };
}

let instance: ModelRecents | undefined;
export function modelRecents() {
  return (instance ??= new ModelRecents(browserStorage("localStorage")));
}
