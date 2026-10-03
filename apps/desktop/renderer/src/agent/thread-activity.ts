import type { AgentBridge, AgentEvent } from "../../../src/bridge.ts";
import type { AgentSnapshot } from "../../../src/agent/protocol.ts";

export function hasThreadActivity(snapshot: AgentSnapshot) {
  return Boolean(
    (snapshot.operation || snapshot.compacting) && !snapshot.recoveryRequired && !snapshot.faulted,
  );
}

/** Watches only known active threads so changing views does not lose their completion events. */
export class ThreadActivity {
  private readonly watches = new Map<string, { unsubscribe?: () => void }>();
  private readonly listeners = new Set<() => void>();
  private running: ReadonlySet<string> = new Set();

  constructor(private readonly bridge: Pick<AgentBridge, "subscribe">) {}

  getSnapshot = () => this.running;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  watch(id: string) {
    if (this.watches.has(id)) return;
    const watch: { unsubscribe?: () => void } = {};
    this.watches.set(id, watch);
    this.update();
    const onEvent = (event: AgentEvent) => {
      if (this.watches.get(id) !== watch) return;
      if (event.type === "snapshot" && hasThreadActivity(event.value.snapshot)) return;
      this.watches.delete(id);
      watch.unsubscribe?.();
      this.update();
    };
    try {
      const unsubscribe = this.bridge.subscribe(id, onEvent);
      if (this.watches.get(id) === watch) watch.unsubscribe = unsubscribe;
      else unsubscribe();
    } catch {
      this.watches.delete(id);
      this.update();
    }
  }

  dispose() {
    const watches = [...this.watches.values()];
    this.watches.clear();
    for (const watch of watches) watch.unsubscribe?.();
    this.update();
  }

  private update() {
    this.running = new Set(this.watches.keys());
    for (const listener of this.listeners) listener();
  }
}
