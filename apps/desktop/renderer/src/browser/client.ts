import type { DesktopBridge } from "../../../src/bridge.ts";
import type { BrowserCommand, BrowserEvent, BrowserState } from "../../../src/browser/protocol.ts";

export interface BrowserViewState {
  page?: BrowserState;
  error?: string;
}

/** IPC failures belong here; page components only manage their mounted viewport. */
export class BrowserClient {
  private state: Readonly<Record<string, BrowserViewState>> = {};
  private readonly listeners = new Set<() => void>();

  constructor(private readonly bridge: Pick<DesktopBridge, "browser" | "subscribeBrowser">) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(listener: (event: BrowserEvent) => void) {
    return this.bridge.subscribeBrowser((event) => {
      if (event.type === "state") this.update(event.state.id, { page: event.state });
      listener(event);
    });
  }

  async command(command: BrowserCommand) {
    if (command.type === "create" && !this.state[command.id])
      this.publish({ ...this.state, [command.id]: {} });
    if (["create", "navigate", "back", "forward", "reload", "stop"].includes(command.type))
      this.update(command.id, { error: undefined });
    try {
      await this.bridge.browser(command);
      return true;
    } catch (error) {
      if (command.type === "close" || command.type === "capture")
        console.warn(`Browser ${command.type} failed for ${command.id}`, error);
      else this.fail(command.id, error);
      return false;
    }
  }

  private fail(id: string, error: unknown) {
    this.update(id, { error: error instanceof Error ? error.message : String(error) });
  }

  retain(ids: ReadonlySet<string>) {
    const entries = Object.entries(this.state).filter(([id]) => ids.has(id));
    if (entries.length !== Object.keys(this.state).length)
      this.publish(Object.fromEntries(entries));
  }

  private update(id: string, patch: Partial<BrowserViewState>) {
    const current = this.state[id];
    // Completion events for an evicted tab cannot recreate its cached state.
    if (!current) return;
    const next = { ...current, ...patch };
    if (next.error !== current.error || next.page !== current.page)
      this.publish({ ...this.state, [id]: next });
  }

  private publish(state: Readonly<Record<string, BrowserViewState>>) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
