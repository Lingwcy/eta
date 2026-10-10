export interface ConversationTab {
  sandboxMode?: import("@eta/core/shared/sandbox").SandboxMode;
  id: string;
  kind: "conversation";
  threadId?: string;
  workspaceId: string | null;
  draft: string;
  environment?: "local" | "cloud";
}

export interface BrowserTab {
  id: string;
  kind: "browser";
  url: string;
  title: string;
}

export interface SettingsTab {
  id: string;
  kind: "settings";
  category?: string;
  categoryRevision?: number;
}

export type DesktopTab = ConversationTab | BrowserTab | SettingsTab;
export interface DesktopTabState {
  tabs: readonly DesktopTab[];
  activeId: string;
  closed: readonly DesktopTab[];
  history: readonly string[];
  historyIndex: number;
}

/** View history only: closing a tab never sends a command to the agent runtime. */
export class DesktopTabs {
  private readonly listeners = new Set<() => void>();
  private state: DesktopTabState;

  constructor(
    private readonly makeId: () => string = () => crypto.randomUUID(),
    restored?: Pick<DesktopTabState, "tabs" | "activeId">,
  ) {
    const tabs = restored?.tabs ?? [this.conversation(null)];
    const activeId = restored?.activeId ?? tabs[0]!.id;
    this.state = { tabs, activeId, closed: [], history: [activeId], historyIndex: 0 };
  }

  getSnapshot = () => this.state;
  get activeTab() {
    return this.state.tabs.find((tab) => tab.id === this.state.activeId)!;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: DesktopTabState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  select(id: string) {
    if (id === this.state.activeId || !this.state.tabs.some((tab) => tab.id === id)) return;
    const history = [...this.state.history.slice(0, this.state.historyIndex + 1), id];
    this.publish({ ...this.state, activeId: id, history, historyIndex: history.length - 1 });
  }

  private add(tab: DesktopTab) {
    const history = [...this.state.history.slice(0, this.state.historyIndex + 1), tab.id];
    this.publish({
      ...this.state,
      tabs: [...this.state.tabs, tab],
      activeId: tab.id,
      history,
      historyIndex: history.length - 1,
    });
    return tab.id;
  }

  private conversation(workspaceId: string | null): ConversationTab {
    return { id: this.makeId(), kind: "conversation", workspaceId, draft: "" };
  }

  newConversation(workspaceId?: string | null) {
    const matches = (tab: DesktopTab) =>
      tab.kind === "conversation" &&
      !tab.threadId &&
      (workspaceId === undefined || tab.workspaceId === workspaceId);
    const active = this.activeTab;
    const existing = matches(active) ? active : this.state.tabs.find(matches);
    if (existing) {
      this.select(existing.id);
      return existing.id;
    }
    return this.add(this.conversation(workspaceId ?? null));
  }

  openThread(threadId: string, workspaceId: string) {
    const existing = this.state.tabs.find(
      (tab) => tab.kind === "conversation" && tab.threadId === threadId,
    );
    if (existing) {
      this.select(existing.id);
      return existing.id;
    }
    // Reuse the initial empty draft when opening saved work.
    const active = this.activeTab;
    if (
      active.kind === "conversation" &&
      !active.threadId &&
      !active.draft &&
      !active.workspaceId
    ) {
      this.updateConversation(active.id, { threadId, workspaceId });
      return active.id;
    }
    return this.add({ id: this.makeId(), kind: "conversation", threadId, workspaceId, draft: "" });
  }

  newBrowser(url = "") {
    return this.add({ id: this.makeId(), kind: "browser", url, title: "新标签页" });
  }

  openSettings(category?: string) {
    const existing = this.state.tabs.find((tab) => tab.kind === "settings");
    if (existing) {
      if (category)
        this.update(existing.id, (tab) => ({
          ...tab,
          category,
          categoryRevision: (existing.categoryRevision ?? 0) + 1,
        }));
      this.select(existing.id);
    } else this.add({ id: this.makeId(), kind: "settings", ...(category ? { category } : {}) });
  }

  updateConversation(id: string, change: Partial<Omit<ConversationTab, "id" | "kind">>) {
    this.update(id, (tab) => {
      if (tab.kind !== "conversation") return tab;
      const next = { ...tab, ...change };
      return next.threadId === tab.threadId &&
        next.workspaceId === tab.workspaceId &&
        next.environment === tab.environment &&
        next.sandboxMode === tab.sandboxMode &&
        next.draft === tab.draft
        ? tab
        : next;
    });
  }

  updateBrowser(id: string, change: Pick<BrowserTab, "url" | "title">) {
    this.update(id, (tab) =>
      tab.kind !== "browser" || (tab.url === change.url && tab.title === change.title)
        ? tab
        : { ...tab, ...change },
    );
  }

  private update(id: string, change: (tab: DesktopTab) => DesktopTab) {
    // Late admission can bind a closed draft, but cannot reopen it or steal focus.
    const key = this.state.tabs.some((tab) => tab.id === id) ? "tabs" : "closed";
    const current = this.state[key];
    const tab = current.find((tab) => tab.id === id);
    if (!tab) return;
    const next = change(tab);
    if (next !== tab)
      this.publish({
        ...this.state,
        [key]: current.map((entry) => (entry === tab ? next : entry)),
      });
  }

  close(id: string) {
    const index = this.state.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const closed = [...this.state.closed, this.state.tabs[index]!].slice(-20);
    const tabs = this.state.tabs.filter((tab) => tab.id !== id);
    if (!tabs.length) tabs.push(this.conversation(null));
    const activeId =
      id === this.state.activeId ? tabs[Math.min(index, tabs.length - 1)]!.id : this.state.activeId;
    const history = this.state.history.filter((entry) => entry !== id);
    if (history.at(-1) !== activeId) history.push(activeId);
    this.publish({ tabs, closed, activeId, history, historyIndex: history.length - 1 });
  }

  /** Catalog updates remove deleted conversations from both open and recently closed tabs. */
  reconcileThreads(threads: readonly { id: string; workspaceId: string }[]) {
    const catalog = new Map(threads.map((thread) => [thread.id, thread]));
    for (const tab of this.state.tabs) {
      if (tab.kind !== "conversation" || !tab.threadId) continue;
      const thread = catalog.get(tab.threadId);
      if (!thread) this.close(tab.id);
      else this.updateConversation(tab.id, { workspaceId: thread.workspaceId });
    }
    const closed = this.state.closed.filter(
      (tab) => tab.kind !== "conversation" || !tab.threadId || catalog.has(tab.threadId),
    );
    if (closed.length !== this.state.closed.length) this.publish({ ...this.state, closed });
  }

  reopen() {
    const tab = this.state.closed.at(-1);
    if (!tab) return;
    this.publish({ ...this.state, closed: this.state.closed.slice(0, -1) });
    const duplicate = this.state.tabs.find(
      (open) =>
        open.id === tab.id ||
        (tab.kind === "settings" && open.kind === "settings") ||
        (tab.kind === "conversation" &&
          tab.threadId &&
          open.kind === "conversation" &&
          open.threadId === tab.threadId),
    );
    if (duplicate) this.select(duplicate.id);
    else this.add(tab);
  }

  navigate(offset: -1 | 1) {
    const index = this.state.historyIndex + offset;
    const id = this.state.history[index];
    if (id) this.publish({ ...this.state, activeId: id, historyIndex: index });
  }

  cycle(offset: -1 | 1) {
    const index = this.state.tabs.findIndex((tab) => tab.id === this.state.activeId);
    this.select(
      this.state.tabs[(index + offset + this.state.tabs.length) % this.state.tabs.length]!.id,
    );
  }

  move(id: string, targetId: string) {
    const from = this.state.tabs.findIndex((tab) => tab.id === id);
    const to = this.state.tabs.findIndex((tab) => tab.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const tabs = [...this.state.tabs];
    tabs.splice(to, 0, tabs.splice(from, 1)[0]!);
    this.publish({ ...this.state, tabs });
  }
}
