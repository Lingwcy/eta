import type { DesktopTabs } from "./desktop-tabs";

const key = "eta.thread-recents.v1";
export interface ThreadVisit {
  threadId: string;
  visitedAt: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** User navigation is separate from session modification; model activity never changes this order. */
export class ThreadRecents {
  private visits: readonly ThreadVisit[];
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    private readonly clock = Date.now,
  ) {
    this.visits = this.read();
  }
  getSnapshot = () => this.visits;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private merge(...sources: readonly (readonly ThreadVisit[])[]) {
    const unique = new Map<string, ThreadVisit>();
    for (const visit of sources.flat()) {
      const prior = unique.get(visit.threadId);
      if (!prior || visit.visitedAt > prior.visitedAt) unique.set(visit.threadId, visit);
    }
    return [...unique.values()].toSorted((a, b) => b.visitedAt - a.visitedAt).slice(0, 1000);
  }
  private read() {
    try {
      const saved: unknown = JSON.parse(this.storage.getItem(key) ?? "null");
      if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.visits)) return [];
      const visits: ThreadVisit[] = [];
      for (const value of saved.visits as unknown[]) {
        if (
          record(value) &&
          typeof value.threadId === "string" &&
          value.threadId &&
          typeof value.visitedAt === "number" &&
          Number.isSafeInteger(value.visitedAt) &&
          value.visitedAt >= 0 &&
          value.visitedAt <= 8_640_000_000_000_000
        )
          visits.push({ threadId: value.threadId, visitedAt: value.visitedAt });
      }
      return this.merge(visits);
    } catch {
      return [];
    }
  }
  private publish(visits: readonly ThreadVisit[]) {
    this.visits = visits;
    for (const listener of this.listeners) listener();
  }
  visit(threadId: string) {
    const visits = this.merge([{ threadId, visitedAt: this.clock() }], this.read(), this.visits);
    this.publish(visits);
    try {
      this.storage.setItem(key, JSON.stringify({ version: 1, visits }));
    } catch {
      /* Navigation still works without storage. */
    }
  }
  connect(tabs: DesktopTabs, target: EventTarget, visible = () => true) {
    let selected: string | undefined;
    const observe = () => {
      const tab = tabs.activeTab;
      const identity = `${tab.id}:${tab.kind === "conversation" ? (tab.threadId ?? "") : ""}`;
      if (selected === identity || !visible()) return;
      selected = identity;
      if (tab.kind === "conversation" && tab.threadId) this.visit(tab.threadId);
    };
    const focus = () => {
      selected = undefined;
      observe();
    };
    const changed = (event: Event) => {
      if ((event as StorageEvent).key === key) this.publish(this.merge(this.read(), this.visits));
    };
    const unsubscribe = tabs.subscribe(observe);
    target.addEventListener("focus", focus);
    target.addEventListener("storage", changed);
    observe();
    return () => {
      unsubscribe();
      target.removeEventListener("focus", focus);
      target.removeEventListener("storage", changed);
    };
  }
}
