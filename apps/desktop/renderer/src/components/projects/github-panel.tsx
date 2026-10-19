import { localizedMessage } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t, currentFormatLocale } from "@/i18n";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { GitRepositoryInfo } from "@eta/core/shared/git";
import type { GitHubItem, GitHubKind, GitHubState } from "@eta/core/shared/github";
import type { GitHubClient } from "@/agent/github-client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  CircleCheck,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MoreHorizontal,
} from "lucide-react";
import { InspectorToolbar } from "@/components/inspector/inspector-tabs";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { ToastNotice } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/** Row treatment matches the rest of Eta: compact type, one meta line, hover surface. */
function GitHubRow({
  kind,
  item,
  separated,
}: {
  kind: GitHubKind;
  item: GitHubItem;
  separated: boolean;
}) {
  useTranslation();
  const merged = item.state === "merged";
  const closed = item.state === "closed";
  const StateIcon =
    kind === "pulls"
      ? item.draft
        ? GitPullRequestDraft
        : merged
          ? GitMerge
          : closed
            ? GitPullRequestClosed
            : GitPullRequest
      : closed
        ? CircleCheck
        : CircleDot;
  const tone = item.draft
    ? "text-neutral-400"
    : merged
      ? "text-violet-500"
      : closed
        ? "text-red-500/80"
        : "text-emerald-600";
  const state = t(`inspector:githubPanel.state.${item.state}`);
  return (
    <article
      className={cn(
        "group flex items-start gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-neutral-100/70",
        separated && "border-t border-neutral-100",
      )}
    >
      <StateIcon size={14} className={cn("mt-[3px] shrink-0", tone)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`${item.title} · #${item.number} · ${state}`}
          className="flex min-w-0 items-baseline gap-1.5 outline-none"
        >
          <span className="line-clamp-2 min-w-0 text-xs font-medium text-neutral-800 decoration-neutral-300 underline-offset-2 group-hover:underline">
            {item.title}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-neutral-600">#{item.number}</span>
        </a>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-neutral-600">
          <span className="max-w-32 truncate">{item.author}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            {new Date(item.updatedAt).toLocaleDateString(currentFormatLocale())}
          </span>
          {item.draft && (
            <span className="rounded-full bg-neutral-100 px-1.5 py-px text-[10px] text-neutral-600">
              {t("inspector:githubPanel.draftBadge")}
            </span>
          )}
          {item.labels.map((label) => (
            <span
              key={label}
              className="max-w-32 truncate rounded-full bg-neutral-100 px-1.5 py-px text-[10px] text-neutral-600"
            >
              {label}
            </span>
          ))}
        </p>
        {item.head && (
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-neutral-600">
            {item.head} <span aria-hidden="true">→</span> {item.base}
          </p>
        )}
      </div>
    </article>
  );
}

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
  useTranslation();
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
            aria-label={t("inspector:githubPanel.githubListOptions")}
            render={<Button variant="ghost-muted" size="icon-tiny" />}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            variant="menu"
            side="bottom"
            initialFocus={false}
            aria-label={t("inspector:githubPanel.githubListOptions")}
          >
            <div className="flex flex-col gap-2 px-1 py-1">
              <p className="px-1 text-xs text-neutral-500">GitHub · {name}</p>
              {remotes.length > 0 && (
                <label className="flex flex-col gap-1 px-1">
                  <span className="text-[11px] text-neutral-500">
                    {t("inspector:githubPanel.browseRepository")}
                  </span>
                  <Select
                    className="w-full"
                    value={selection?.remote ?? ""}
                    options={remotes.map((remote) => ({
                      value: remote.name,
                      label: `${remote.name} · ${remote.github!.owner}/${remote.github!.repo}`,
                    }))}
                    label={t("inspector:githubPanel.remote")}
                    placeholder={t("inspector:githubPanel.chooseRemote")}
                    size="compact"
                    variant="menu"
                    disabled={!connected || view.loading}
                    onValueChange={(remote) => void onRemote(remote)}
                  />
                </label>
              )}
              {!selection && (
                <p className="text-xs text-neutral-500">
                  {t("inspector:githubPanel.chooseAGithubRepositoryToBrowse")}
                </p>
              )}
              <label className="flex flex-col gap-1 px-1">
                <span className="text-[11px] text-neutral-500">
                  {t("inspector:githubPanel.githubStateFilter")}
                </span>
                <Select
                  className="w-full"
                  value={state}
                  options={[
                    { value: "open", label: t("inspector:githubPanel.open") },
                    { value: "closed", label: t("inspector:githubPanel.closedFilter") },
                    { value: "all", label: t("inspector:githubPanel.all") },
                  ]}
                  label={t("inspector:githubPanel.githubStateFilter")}
                  size="compact"
                  variant="menu"
                  onValueChange={(next) =>
                    setFilters((current) => ({ ...current, [kind]: next as GitHubState }))
                  }
                />
              </label>
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
                  {t("inspector:githubPanel.refresh")}
                </Button>
              </div>
              {page && (
                <p className="text-[11px] text-neutral-500">
                  {page.identity.login
                    ? t("inspector:githubPanel.identity", { login: page.identity.login })
                    : t("inspector:githubPanel.anonymousAccessSignInWithGithubCli")}{" "}
                  · {new Date(page.fetchedAt).toLocaleTimeString(currentFormatLocale())}
                  {page.stale || !connected ? t("inspector:githubPanel.stale") : ""}
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </InspectorToolbar>
      {!connected && (
        <p role="status" className="text-xs text-neutral-500">
          {t("inspector:githubPanel.botIsDisconnectedTheCacheMayBe")}
        </p>
      )}
      {view.loading && (
        <p role="status" className="text-xs text-neutral-500">
          {t("inspector:githubPanel.readingGithub")}
        </p>
      )}
      <ToastNotice
        title={localizedMessage("inspector:githubPanel.theGithubRequestCouldNotBeCompleted")}
        message={
          view.error &&
          `${view.error.message}${view.error.retryAt ? t("inspector:githubPanel.retryAfter", { value1: new Date(view.error.retryAt).toLocaleString(currentFormatLocale()) }) : ""}`
        }
      />
      {page && (
        <>
          {!page.items.length && (
            <p className="text-xs text-neutral-500">
              {t("inspector:githubPanel.empty", {
                state: t(`inspector:githubPanel.state.${state}`),
                kind: kind === "pulls" ? "PR" : "Issues",
                more: page.nextCursor
                  ? t("inspector:githubPanel.morePagesMayStillBeAvailable")
                  : "",
              })}
            </p>
          )}
          <div className="flex flex-col">
            {page.items.map((item, index) => (
              <GitHubRow key={item.number} kind={kind} item={item} separated={index > 0} />
            ))}
          </div>
          {page.nextCursor && (
            <Button
              variant="ghost-muted"
              size="row-sm"
              className="justify-center text-neutral-500"
              disabled={!connected || view.loading || limited}
              onClick={() => void client.load(key, { ...query, cursor: page!.nextCursor }, true)}
            >
              {t("inspector:githubPanel.loadMore")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
