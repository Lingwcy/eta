import type { DesktopBridge, DesktopLibrary } from "../../../src/bridge.ts";
import type { DesktopSettings } from "../../../src/shared/settings.ts";

type LibraryBridge = Pick<DesktopBridge, "library" | "subscribeLibrary" | "updateSettings">;

/** Mutations own their refresh; library notifications during a mutation are covered by that read. */
export class DesktopLibraryClient {
  private state: { library: DesktopLibrary | null; error: string | null; busy: boolean } = {
    library: null,
    error: null,
    busy: false,
  };
  private readonly listeners = new Set<() => void>();
  private unsubscribeLibrary?: () => void;
  private mounted = false;
  private revision = 0;
  private invalidated = false;

  constructor(private readonly bridge: LibraryBridge) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect() {
    this.mounted = true;
    this.unsubscribeLibrary = this.bridge.subscribeLibrary(() => {
      if (this.state.busy) this.invalidated = true;
      else this.reload();
    });
    this.reload();
  }

  dispose() {
    this.mounted = false;
    this.revision++;
    this.unsubscribeLibrary?.();
    this.unsubscribeLibrary = undefined;
  }

  refresh = async () => {
    const epoch = ++this.revision;
    const library = await this.bridge.library();
    if (this.mounted && epoch === this.revision) this.update({ library });
    return library;
  };

  reload = () => {
    void this.refresh().catch(this.reportError);
  };

  clearError = () => this.update({ error: null });

  act = async (action: () => Promise<void>) => {
    try {
      await this.mutate(action);
    } catch {
      // The shared error is displayed by the desktop shell.
    }
  };

  updateSettings = (patch: Partial<DesktopSettings>) =>
    this.mutate(async () => {
      await this.bridge.updateSettings(patch);
    });

  private async mutate(action: () => Promise<void>) {
    if (this.state.busy) return;
    this.update({ busy: true, error: null });
    try {
      await action();
      do {
        this.invalidated = false;
        await this.refresh();
      } while (this.invalidated);
    } catch (error) {
      this.reportError(error);
      // A failed mutation may still have changed durable state or overlapped a library notification.
      this.reload();
      throw error;
    } finally {
      this.update({ busy: false });
    }
  }

  private reportError = (error: unknown) => {
    if (this.mounted)
      this.update({ error: error instanceof Error ? error.message : String(error) });
  };

  private update(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
