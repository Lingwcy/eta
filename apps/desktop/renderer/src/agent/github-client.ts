import type { DesktopBridge } from "../../../src/bridge.ts";
import type { GitHubQuery, GitHubPage } from "@eta/core/shared/github";

type ReadyPage = Extract<GitHubPage, { status: "ready" }>;
export type GitHubView = {
  readonly page?: ReadyPage;
  readonly error?: Extract<GitHubPage, { status: "error" }>;
  readonly loading: boolean;
};
const empty: GitHubView = { loading: false };

/** Results are keyed by execution project, remote, kind and filter; cancelled generations never repopulate a cache. */
export class GitHubClient {
  private entries = new Map<string, GitHubView>();
  private listeners = new Set<() => void>();
  private generation = 0;
  private pending = new Map<string, Promise<void>>();
  readonly filters = new Map<string, Pick<GitHubQuery, "kind" | "state">>();
  constructor(private readonly bridge: Pick<DesktopBridge, "githubQuery">) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get = (key: string) => this.entries.get(key) ?? empty;
  private set(key: string, value: GitHubView) {
    this.entries.set(key, value);
    for (const notify of this.listeners) notify();
  }
  clear() {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
    for (const notify of this.listeners) notify();
  }
  load(key: string, input: GitHubQuery, append = false) {
    const running = this.pending.get(key);
    if (running) return running;
    const previous = this.get(key).page;
    if (!append && !input.refresh && previous && Date.now() - previous.fetchedAt < 60_000)
      return Promise.resolve();
    const generation = this.generation;
    this.set(key, { ...(previous ? { page: previous } : {}), loading: true });
    const promise = this.bridge
      .githubQuery(input)
      .then(
        (result) => {
          if (generation !== this.generation) return;
          if (result.status === "error") {
            // Authentication or repository changes must not leave another identity's private list on screen.
            const stale =
              result.cached ??
              (["network", "rate-limit", "unavailable"].includes(result.code)
                ? previous && { ...previous, stale: true }
                : undefined);
            this.set(key, { ...(stale ? { page: stale } : {}), error: result, loading: false });
            return;
          }
          const sameRepository =
            previous &&
            JSON.stringify(previous.repository) === JSON.stringify(result.repository) &&
            JSON.stringify(previous.identity) === JSON.stringify(result.identity);
          const page =
            append && sameRepository
              ? {
                  ...result,
                  items: [
                    ...new Map(
                      [...previous.items, ...result.items].map((item) => [item.number, item]),
                    ).values(),
                  ],
                }
              : result;
          this.set(key, { page, loading: false });
        },
        () => {
          if (generation === this.generation)
            this.set(key, {
              ...(previous ? { page: { ...previous, stale: true } } : {}),
              error: {
                status: "error",
                code: "network",
                message: "无法连接宿主，请重新连接后刷新。",
              },
              loading: false,
            });
        },
      )
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
}
