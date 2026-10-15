import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { GitRepositoryInfo } from "@eta/core/shared/git";
import type { GitHubKind, GitHubState } from "@eta/core/shared/github";
import type { GitHubClient } from "@/agent/github-client";
import { Button } from "@/components/ui/button";
import { MoreHorizontal } from "lucide-react";
import { InspectorToolbar } from "@/components/inspector/inspector-tabs";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { ToastNotice } from "@/components/ui/toast";

export function GitHubPanel({
  client,
  projectId,
  name,
  info,
  connected,
  onRefresh,
  onRemote,
}: {
  client: GitHubClient;
  projectId: string;
  name: string;
  info?: GitRepositoryInfo;
  connected: boolean;
  onRefresh: () => void;
  onRemote: (remote: string) => Promise<void>;
}) {
  const saved = client.filters.get(projectId);
  const [kind, setKind] = useState<GitHubKind>(saved?.kind ?? "pulls");
  const [filters, setFilters] = useState<Record<GitHubKind, GitHubState>>({
    pulls: "open",
    issues: "open",
  });
  const state = filters[kind];
  const selection = info?.status === "ready" ? info.github?.selection : undefined;
  const remotes = info?.status === "ready" ? info.remotes.filter((remote) => remote.github) : [];
  const key = JSON.stringify([
    projectId,
    info?.status === "ready" ? info.commonDir : "",
    selection,
    kind,
    state,
  ]);
  const view = useSyncExternalStore(client.subscribe, () => client.get(key));
  const [, setClock] = useState(0);
  useEffect(() => {
    const delay = (view.error?.retryAt ?? 0) - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(
      () => setClock((value) => value + 1),
      Math.min(delay + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [view.error?.retryAt]);
  const query = { projectId, kind, state };
  const matches =
    !view.page ||
    (info?.status === "ready" &&
      selection &&
      view.page.repository.commonDir === info.commonDir &&
      view.page.repository.remote === selection.remote &&
      view.page.repository.owner === selection.owner &&
      view.page.repository.repo === selection.repo);
  const page = matches ? view.page : undefined;
  const checked = useRef<string | undefined>(undefined);
  const check =
    !matches || view.error?.code === "selection-required"
      ? JSON.stringify([key, view.page?.repository, view.error?.code, view.page?.fetchedAt])
      : undefined;
  useEffect(() => {
    if (check && checked.current !== check) {
      checked.current = check;
      onRefresh();
    }
  }, [check, onRefresh]);
  useEffect(() => {
    client.filters.set(projectId, { kind, state });
    client.filters.set(`${projectId}:${kind}`, { kind, state });
    if (selection && connected) void client.load(key, { projectId, kind, state });
  }, [client, projectId, key, kind, state, Boolean(selection), connected]);
  const limited = Boolean(view.error?.retryAt && view.error.retryAt > Date.now());
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <InspectorToolbar>
        <Button
          variant="ghost"
          size="toolbar"
          aria-pressed={kind === "pulls"}
          onClick={() => setKind("pulls")}
        >
          <span className={kind === "pulls" ? "text-neutral-800" : "text-neutral-400"}>PR</span>
        </Button>
        <Button
          variant="ghost"
          size="toolbar"
          aria-pressed={kind === "issues"}
          onClick={() => setKind("issues")}
        >
          <span className={kind === "issues" ? "text-neutral-800" : "text-neutral-400"}>
            Issues
          </span>
        </Button>
        <Popover>
          <PopoverTrigger
            aria-label="GitHub 列表选项"
            render={<Button variant="ghost-muted" size="icon-tiny" />}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            variant="menu"
            side="bottom"
            initialFocus={false}
            aria-label="GitHub 列表选项"
          >
            <div className="flex flex-col gap-1 px-2 py-1">
              <p className="text-xs text-neutral-500">GitHub · {name}</p>
              {remotes.length > 0 && (
                <label className="text-xs">
                  浏览仓库
                  <select
                    className="max-w-full bg-transparent text-xs outline-none"
                    aria-label="GitHub remote"
                    value={selection?.remote ?? ""}
                    disabled={!connected || view.loading}
                    onChange={(event) => void onRemote(event.target.value)}
                  >
                    <option value="" disabled>
                      选择 remote
                    </option>
                    {remotes.map((remote) => (
                      <option key={remote.name} value={remote.name}>
                        {remote.name} · {remote.github!.owner}/{remote.github!.repo}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!selection && (
                <p className="text-xs text-neutral-500">请选择要查看的 GitHub 仓库。</p>
              )}
              <select
                className="bg-transparent text-xs outline-none"
                aria-label="GitHub 状态筛选"
                value={state}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    [kind]: event.target.value as GitHubState,
                  }))
                }
              >
                <option value="open">Open</option>
                <option value="closed">Closed / Merged</option>
                <option value="all">全部</option>
              </select>
              <div className="flex gap-1">
                <Button
                  variant="menu"
                  size="menu-item"
                  disabled={!connected || view.loading || limited}
                  onClick={() => {
                    onRefresh();
                    if (selection) void client.load(key, { ...query, refresh: true });
                  }}
                >
                  刷新
                </Button>
              </div>
              {page && (
                <p className="text-[11px] text-neutral-500">
                  {page.identity.login
                    ? `GitHub：${page.identity.login}`
                    : "匿名访问；登录 GitHub CLI 可提高额度"}{" "}
                  · {new Date(page.fetchedAt).toLocaleTimeString()}
                  {page.stale || !connected ? " · 已过期" : ""}
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </InspectorToolbar>
      {!connected && (
        <p role="status" className="text-xs text-neutral-500">
          Bot 未连接，缓存可能已过期。
        </p>
      )}
      {view.loading && (
        <p role="status" className="text-xs text-neutral-500">
          正在读取 GitHub…
        </p>
      )}
      <ToastNotice
        title="GitHub 请求未完成"
        message={
          view.error &&
          `${view.error.message}${view.error.retryAt ? ` 可重试时间：${new Date(view.error.retryAt).toLocaleString()}` : ""}`
        }
      />
      {page && (
        <>
          {!page.items.length && (
            <p className="text-xs text-neutral-500">
              当前 {state} 筛选下没有{kind === "pulls" ? " PR" : " Issue"}
              {page.nextCursor ? "；后续页仍可继续加载" : ""}。
            </p>
          )}
          {page.items.map((item) => (
            <article key={item.number} className="space-y-1 border-b border-neutral-200 pb-2">
              <a
                className="block text-xs font-medium text-neutral-800 underline-offset-2 hover:underline"
                href={item.url}
                target="_blank"
                rel="noreferrer"
              >
                #{item.number} {item.title}
              </a>
              <p className="text-[11px] text-neutral-500">
                {item.state}
                {item.draft ? " · Draft" : ""} · {item.author} ·{" "}
                {new Date(item.updatedAt).toLocaleDateString()}
              </p>
              {item.head && (
                <p className="break-all text-[11px] text-neutral-500">
                  {item.head} → {item.base}
                </p>
              )}
              {!!item.labels.length && (
                <p className="text-[11px] text-neutral-500">{item.labels.join(" · ")}</p>
              )}
            </article>
          ))}
          {page.nextCursor && (
            <Button
              variant="outline"
              size="sm"
              disabled={!connected || view.loading || limited}
              onClick={() => void client.load(key, { ...query, cursor: page!.nextCursor }, true)}
            >
              加载更多
            </Button>
          )}
        </>
      )}
    </div>
  );
}
