import { browserAddress } from "../../browser/protocol.ts";
import type {
  BrowserBounds,
  BrowserCommand,
  BrowserEvent,
  BrowserState,
} from "../../browser/protocol.ts";

export interface BrowserPage {
  state(): BrowserState;
  load(url: string): Promise<void>;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  bounds(value: BrowserBounds): void;
  visible(value: boolean): void;
  capture(): Promise<string | undefined>;
  close(): void;
}

/** Owns native page resources for one window, independent of the selected UI tab. */
export class BrowserManager {
  private readonly pages = new Map<
    string,
    { page: BrowserPage; preview?: string; error?: string; revision: number }
  >();
  private activeId?: string;
  private disposed = false;

  constructor(
    private readonly createPage: (id: string, changed: () => void) => BrowserPage,
    private readonly emit: (event: BrowserEvent) => void,
  ) {}

  private snapshot(id: string): BrowserState {
    const record = this.pages.get(id);
    if (!record) throw new Error("网页标签已经关闭");
    return {
      ...record.page.state(),
      ...(record.error ? { error: record.error } : {}),
      ...(record.preview ? { preview: record.preview } : {}),
    };
  }

  changed(id: string) {
    if (this.pages.has(id) && !this.disposed)
      this.emit({ type: "state", state: this.snapshot(id) });
  }

  async command(command: BrowserCommand): Promise<BrowserState | null> {
    if (this.disposed) throw new Error("浏览器窗口已经关闭");
    const { id } = command;
    if (command.type === "create") {
      if (!this.pages.has(id)) {
        const url = browserAddress(command.url);
        const page = this.createPage(id, () => this.changed(id));
        this.pages.set(id, { page, revision: 0 });
        page.visible(false);
        this.load(id, url);
      }
      return this.snapshot(id);
    }
    const record = this.pages.get(id);
    // Late ResizeObserver/disposer messages are harmless after a tab was closed.
    if (!record && (command.type === "close" || command.type === "hide" || command.type === "show"))
      return null;
    if (!record) throw new Error("网页标签不存在");
    const { page } = record;
    switch (command.type) {
      case "navigate":
        this.load(id, browserAddress(command.url));
        break;
      case "back":
        if (page.state().canGoBack) page.back();
        break;
      case "forward":
        if (page.state().canGoForward) page.forward();
        break;
      case "reload":
        record.error = undefined;
        page.reload();
        break;
      case "stop":
        page.stop();
        break;
      case "show": {
        if (this.activeId && this.activeId !== id)
          this.pages.get(this.activeId)?.page.visible(false);
        this.activeId = id;
        page.bounds(command.bounds);
        page.visible(true);
        break;
      }
      case "hide": {
        if (this.activeId === id) {
          // Native views sit above HTML popovers. Freeze the page behind the popup.
          const capture = this.capture(id, page);
          page.visible(false);
          this.activeId = undefined;
          const preview = await capture;
          if (this.pages.get(id) === record) {
            if (preview) record.preview = preview;
            this.changed(id);
          }
        }
        break;
      }
      case "capture": {
        const preview = await this.capture(id, page);
        if (this.pages.get(id) !== record) return null;
        if (preview) record.preview = preview;
        this.changed(id);
        break;
      }
      case "close": {
        this.pages.delete(id);
        if (this.activeId === id) this.activeId = undefined;
        page.close();
        return null;
      }
    }
    return this.pages.has(id) ? this.snapshot(id) : null;
  }

  private async capture(id: string, page: BrowserPage) {
    try {
      return await page.capture();
    } catch (error) {
      // A failed preview does not interrupt browsing, but remains diagnosable.
      console.warn(`Unable to capture browser preview for ${id}`, error);
    }
  }

  private load(id: string, url: string) {
    const record = this.pages.get(id)!;
    const revision = ++record.revision;
    record.error = undefined;
    void record.page.load(url).catch((error: unknown) => {
      if (this.pages.get(id) !== record || this.disposed || revision !== record.revision) return;
      // ERR_ABORTED is expected when the next navigation overtakes an earlier load.
      if (error instanceof Error && error.message.includes("ERR_ABORTED")) return;
      record.error = "网页暂时无法打开，请检查网址或重试";
      this.changed(id);
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const pages = [...this.pages.values()];
    this.pages.clear();
    this.activeId = undefined;
    for (const { page } of pages) page.close();
  }
}
