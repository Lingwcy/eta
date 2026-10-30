import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import type {
  DiffContent,
  DiffFile,
  WorkspaceChanges,
  WorkspaceDiffScope,
} from "@eta/core/shared/diff";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { useDiffQuery } from "@/agent/use-diff-query";
import { cn } from "@/lib/utils";
import { DiffPreview, type DiffLayout } from "./diff-preview";

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
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="p-3 text-xs text-neutral-500">
      {children}
    </p>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: DiffFile;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs outline-none hover:bg-neutral-200/50 focus-visible:ring-2 focus-visible:ring-neutral-400",
        selected && "bg-neutral-200/70",
      )}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    >
      <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
      <span
        className={cn(
          "shrink-0 text-[10px]",
          file.kind === "added" || file.kind === "untracked"
            ? "text-emerald-700"
            : file.kind === "deleted" || file.kind === "conflicted"
              ? "text-red-600"
              : "text-neutral-500",
        )}
      >
        {t(`diff:kind.${file.kind}`)}
      </span>
    </button>
  );
}

/** One inspector view shares the renderer, but never the data source, of historical and live diffs. */
export function DiffPanel({
  workspaceId,
  history,
  active,
  revision = 0,
  connectionKey = "local",
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
  const [scope, setScope] = useState<WorkspaceDiffScope>("all");
  const [selectedPaths, setSelectedPaths] = useState<Record<string, string>>({});
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [refresh, setRefresh] = useState(0);
  const positions = useRef(new Map<string, number>());
  const workspaceKey = JSON.stringify([connectionKey, workspaceId, scope]);
  const listKey = JSON.stringify([workspaceKey, refresh]);
  const previousRevision = useRef(revision);
  useEffect(() => {
    const previous = previousRevision.current;
    previousRevision.current = revision;
    if (previous === revision || !active || source !== "workspace") return;
    // Nested tools can finish together; invalidate once after the burst, not once per result.
    const timer = setTimeout(() => setRefresh((value) => value + 1), 100);
    return () => clearTimeout(timer);
  }, [revision, active, source]);
  const list = useDiffQuery<WorkspaceChanges>(
    listKey,
    active && source === "workspace" && Boolean(workspaceId),
    () => window.eta.workspaceChanges({ workspaceId: workspaceId!, scope }),
  );
  const files = list.status === "ready" && list.value.status === "ready" ? list.value.files : [];
  const file = files.find((entry) => entry.path === selectedPaths[workspaceKey]) ?? files[0];
  const listRevision =
    list.status === "ready" && list.value.status === "ready" ? list.value.revision : undefined;
  const contentKey =
    source === "history"
      ? JSON.stringify([historyKey, refresh])
      : JSON.stringify([workspaceKey, listRevision, file?.id, refresh]);
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
  useEffect(() => {
    if (!active || source !== "workspace") return;
    const onFocus = () => setRefresh((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, source]);
  const location = source === "history" ? historyKey : JSON.stringify([workspaceKey, file?.path]);
  const path = source === "history" ? history?.path : file?.path;
  const retry = (
    <Button variant="ghost" size="toolbar" onClick={() => setRefresh((value) => value + 1)}>
      {t("diff:retry")}
    </Button>
  );
  if (!active) return null;
  let body;
  if (source === "workspace" && !workspaceId) body = <Notice>{t("diff:noWorkspace")}</Notice>;
  else if (source === "workspace" && list.status === "loading")
    body = <Notice>{t("diff:loading")}</Notice>;
  else if (source === "workspace" && list.status === "error")
    body = (
      <Notice>
        {t("diff:error")} {retry}
      </Notice>
    );
  else if (
    source === "workspace" &&
    list.status === "ready" &&
    list.value.status === "not-repository"
  )
    body = <Notice>{t("diff:notRepository")}</Notice>;
  else if (source === "workspace" && !file) body = <Notice>{t("diff:noChanges")}</Notice>;
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
        layout={layout}
        location={location}
        positions={positions.current}
      />
    );
  return (
    <section aria-label={t("diff:title")} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-1 border-b border-neutral-200/70 px-2">
        <div role="group" aria-label={t("diff:source")} className="flex min-w-0 flex-1 gap-1">
          {history && (
            <Button
              variant="ghost"
              size="toolbar"
              selected={source === "history"}
              aria-pressed={source === "history"}
              onClick={() => setSelection({ navigationKey, source: "history" })}
            >
              {t("diff:history")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="toolbar"
            selected={source === "workspace"}
            aria-pressed={source === "workspace"}
            onClick={() => setSelection({ navigationKey, source: "workspace" })}
          >
            {t("diff:workspace")}
          </Button>
        </div>
        <Button
          variant="ghost-muted"
          size="icon-tiny"
          aria-label={t("diff:refresh")}
          title={t("diff:refresh")}
          onClick={() => setRefresh((value) => value + 1)}
          disabled={source === "workspace" && !workspaceId}
        >
          <RefreshCw size={13} aria-hidden="true" />
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 border-b border-neutral-200/70 px-2">
        {source === "workspace" && (
          <div role="group" aria-label={t("diff:scope")} className="flex gap-1">
            {(["all", "staged", "unstaged"] as const).map((value) => (
              <Button
                key={value}
                variant="ghost"
                size="toolbar"
                selected={scope === value}
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
              >
                {t(`diff:${value}`)}
              </Button>
            ))}
          </div>
        )}
        <div role="group" aria-label={t("diff:layout")} className="flex gap-1">
          {(["unified", "split"] as const).map((value) => (
            <Button
              key={value}
              variant="ghost"
              size="toolbar"
              selected={layout === value}
              aria-pressed={layout === value}
              onClick={() => setLayout(value)}
            >
              {t(`diff:${value}`)}
            </Button>
          ))}
        </div>
      </div>
      {source === "workspace" && files.length > 0 && (
        <div
          aria-label={t("diff:files")}
          className="max-h-40 shrink-0 overflow-y-auto border-b border-neutral-200/70 px-1 py-1"
        >
          {files.map((entry) => (
            <FileRow
              key={entry.id}
              file={entry}
              selected={file?.id === entry.id}
              onSelect={() =>
                setSelectedPaths((previous) => ({ ...previous, [workspaceKey]: entry.path }))
              }
            />
          ))}
          {list.status === "ready" && list.value.status === "ready" && list.value.truncated && (
            <Notice>{t("diff:truncated")}</Notice>
          )}
        </div>
      )}
      {path && (
        <div
          className="shrink-0 truncate border-b border-neutral-200/70 px-2 py-1 font-mono text-[11px] text-neutral-500"
          title={path}
        >
          {path}
        </div>
      )}
      {body}
    </section>
  );
}
