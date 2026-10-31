import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DiffContent } from "@eta/core/shared/diff";
import { useWorkspaceDiff, type WorkspaceDiffQuery } from "@/agent/use-code-diff";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { useDiffQuery } from "@/agent/use-diff-query";
import { DiffPreview } from "./diff-preview";
import { DiffFileTree } from "./diff-file-tree";
import { DiffFilePane } from "./diff-file-pane";

export interface DiffHistorySelection {
  threadId: string;
  changeId: string;
  path: string;
  /** New navigation intent, even when opening the same modification again. */
  requestId?: string;
}

interface DiffPanelProps {
  workspaceId?: string;
  history?: DiffHistorySelection;
  active: boolean;
  /** A completed modification or turn, not each streamed token. */
  revision?: number;
  /** Includes the remote connection admission, not only a URL or workspace ID. */
  connectionKey?: string;
  workspace?: WorkspaceDiffQuery;
  onWorkspaceSelect?: () => void;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="p-3 text-xs text-neutral-500">
      {children}
    </p>
  );
}

/** One inspector view shares the renderer, but never the data source, of historical and live diffs. */
export function DiffPanel({
  workspaceId,
  history,
  active,
  revision = 0,
  connectionKey = "local",
  workspace,
  onWorkspaceSelect,
}: DiffPanelProps) {
  useTranslation();
  const historyKey = JSON.stringify([connectionKey, history?.threadId, history?.changeId]);
  const navigationKey = JSON.stringify([historyKey, history?.requestId]);
  const [selection, setSelection] = useState({
    navigationKey,
    source: history ? "history" : "workspace",
  });
  const source =
    selection.navigationKey !== navigationKey
      ? history
        ? "history"
        : "workspace"
      : selection.source;
  useEffect(() => {
    setSelection((previous) =>
      previous.navigationKey === navigationKey
        ? previous
        : { navigationKey, source: history ? "history" : "workspace" },
    );
  }, [navigationKey, Boolean(history)]);
  const scope = "all";
  const [selectedPaths, setSelectedPaths] = useState<Record<string, string>>({});
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, ReadonlySet<string>>>({});
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const positions = useRef(new Map<string, number>());
  const workspaceKey = JSON.stringify([connectionKey, workspaceId, scope]);
  // The shell probes availability even while closed; reuse that admission when present.
  const localWorkspace = useWorkspaceDiff({
    workspaceId,
    connectionKey,
    revision,
    enabled: active && !workspace,
  });
  const list = workspace ?? localWorkspace;
  const files = list.status === "ready" && list.value.status === "ready" ? list.value.files : [];
  const file = files.find((entry) => entry.path === selectedPaths[workspaceKey]) ?? files[0];
  const listRevision =
    list.status === "ready" && list.value.status === "ready" ? list.value.revision : undefined;
  const contentKey =
    source === "history"
      ? JSON.stringify([navigationKey, historyRefresh])
      : JSON.stringify([workspaceKey, listRevision, file?.id, list.generation]);
  const content = useDiffQuery<DiffContent>(
    contentKey,
    active && (source === "history" ? Boolean(history) : Boolean(file && listRevision)),
    () =>
      source === "history"
        ? window.eta.fileChangeDiff({ threadId: history!.threadId, changeId: history!.changeId })
        : window.eta.workspaceFileDiff({
            workspaceId: workspaceId!,
            scope,
            entryId: file!.id,
            expectedRevision: listRevision!,
          }),
  );
  const location = source === "history" ? historyKey : JSON.stringify([workspaceKey, file?.path]);
  const retry = (
    <Button
      variant="ghost"
      size="toolbar"
      onClick={() =>
        source === "history" ? setHistoryRefresh((value) => value + 1) : list.refresh()
      }
    >
      {t("diff:retry")}
    </Button>
  );
  if (!active) return null;
  let body;
  if (
    source === "workspace" &&
    (!workspaceId || list.status !== "ready" || list.value.status !== "ready" || !file)
  )
    body = null;
  else if (content.status === "loading") body = <Notice>{t("diff:loading")}</Notice>;
  else if (content.status === "error")
    body = (
      <Notice>
        {t("diff:error")} {retry}
      </Notice>
    );
  else if (content.value.status === "unavailable")
    body = (
      <Notice>
        {t(`diff:reason.${content.value.reason}`)} {content.value.reason === "stale" && retry}
      </Notice>
    );
  else if (!content.value.patch.trim()) body = <Notice>{t("diff:noDifference")}</Notice>;
  else
    body = (
      <DiffPreview
        patch={content.value.patch}
        layout="unified"
        location={location}
        positions={positions.current}
      />
    );
  let fileTree;
  if (!workspaceId) fileTree = <Notice>{t("diff:noWorkspace")}</Notice>;
  else if (list.status === "loading") fileTree = <Notice>{t("diff:loading")}</Notice>;
  else if (list.status === "error")
    fileTree = (
      <Notice>
        {t("diff:error")}{" "}
        <Button variant="ghost" size="toolbar" onClick={list.refresh}>
          {t("diff:retry")}
        </Button>
      </Notice>
    );
  else if (list.value.status === "not-repository")
    fileTree = <Notice>{t("diff:notRepository")}</Notice>;
  else if (!files.length) fileTree = <Notice>{t("diff:noChanges")}</Notice>;
  else
    fileTree = (
      <DiffFileTree
        key={workspaceKey}
        files={files}
        collapsed={collapsedPaths[workspaceKey] ?? new Set()}
        onToggle={(path) =>
          setCollapsedPaths((previous) => {
            const next = new Set(previous[workspaceKey]);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return { ...previous, [workspaceKey]: next };
          })
        }
        selectedId={source === "workspace" ? file?.id : undefined}
        onSelect={(entry) => {
          setSelectedPaths((previous) => ({ ...previous, [workspaceKey]: entry.path }));
          setSelection({ navigationKey, source: "workspace" });
          onWorkspaceSelect?.();
        }}
      />
    );
  return (
    <section aria-label={t("diff:title")} className="flex min-h-0 min-w-0 flex-1 dark:bg-[#141414]">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
      <DiffFilePane>
        {source === "history" && history && (
          <div
            className="flex items-center gap-2 px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400"
            title={history.path}
          >
            <span className="shrink-0">{t("diff:history")}</span>
            <span className="min-w-0 truncate">
              {history.path.split("/").at(-1) || history.path}
            </span>
          </div>
        )}
        {fileTree}
        {list.status === "ready" && list.value.status === "ready" && list.value.truncated && (
          <Notice>{t("diff:truncated")}</Notice>
        )}
      </DiffFilePane>
    </section>
  );
}
