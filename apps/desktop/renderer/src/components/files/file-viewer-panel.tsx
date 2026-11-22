import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSharedHighlighter, type ThemedToken } from "@pierre/diffs";
import {
  Check,
  ChevronRight,
  Code2,
  Copy,
  ExternalLink,
  FileDiff,
  Folder,
  RotateCw,
  X,
} from "lucide-react";
import { useResolvedTheme } from "@/appearance";
import { InspectorToolbar } from "@/components/inspector/inspector-tabs";
import { Button } from "@/components/ui/button";
import { ToastNotice } from "@/components/ui/toast";
import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { OpenFileTab } from "@/agent/use-file-viewer";
import type {
  FileEditorOption,
  OpenFileTargetMode,
  WorkspaceFilePreviewResult,
} from "../../../../src/shared/workspace-files.ts";
import { FileTypeIcon } from "./file-type-icon";

interface HighlightState {
  readonly content: string;
  readonly language: string;
  readonly theme: string;
  readonly tokens: ThemedToken[][];
}

function splitPathSegments(path: string, rootName?: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (!rootName) return parts;
  return parts[0] === rootName ? parts : [rootName, ...parts];
}

export function FileViewerPanel({
  tabs,
  active,
  refreshRevision,
  onSelect,
  onClose,
  onRefresh,
  changedPaths,
  onOpenDiff,
  editors,
  cloud,
}: {
  tabs: readonly OpenFileTab[];
  active: OpenFileTab;
  refreshRevision: number;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onRefresh: (key: string) => void;
  changedPaths?: ReadonlySet<string>;
  onOpenDiff?: (path: string) => void;
  editors: readonly FileEditorOption[];
  cloud: boolean;
}) {
  useTranslation();
  const theme = useResolvedTheme() === "dark" ? "pierre-dark" : "pierre-light";
  const resourceIdentity = JSON.stringify([active.key, active.workspaceId ?? "", active.path]);

  const [loaded, setLoaded] = useState<{
    readonly identity: string;
    readonly result: WorkspaceFilePreviewResult;
  }>();
  const [loadingIdentity, setLoadingIdentity] = useState<string>();
  const [readError, setReadError] = useState<{
    readonly identity: string;
    readonly message: Message;
  }>();
  const [actionError, setActionError] = useState<Message>();
  const [highlight, setHighlight] = useState<HighlightState>();
  const [copiedPath, setCopiedPath] = useState<string>();
  const targetLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingIdentity(resourceIdentity);
    setReadError((current) => (current?.identity === resourceIdentity ? undefined : current));
    void window.eta
      .readWorkspaceFile({ workspaceId: active.workspaceId, path: active.path })
      .then((result) => {
        if (cancelled) return;
        setLoaded({ identity: resourceIdentity, result });
        setLoadingIdentity((current) => (current === resourceIdentity ? undefined : current));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setReadError({
          identity: resourceIdentity,
          message: describeError(cause, localizedMessage("inspector:fileViewer.reason.unreadable")),
        });
        setLoadingIdentity((current) => (current === resourceIdentity ? undefined : current));
      });
    return () => {
      cancelled = true;
    };
  }, [resourceIdentity, active.workspaceId, active.path, refreshRevision]);

  const preview = loaded?.identity === resourceIdentity ? loaded.result : undefined;
  const activeError = readError?.identity === resourceIdentity ? readError.message : undefined;
  const isInitialLoading = loadingIdentity === resourceIdentity && !preview;

  const readyPreview = preview?.status === "ready" ? preview : undefined;
  useEffect(() => {
    const language = readyPreview?.language;
    const content = readyPreview?.content;
    if (
      !language ||
      content === undefined ||
      content.length > 100_000 ||
      content.split("\n").some((line) => line.length > 2000)
    )
      return;
    let activeLoad = true;
    void getSharedHighlighter({
      themes: [theme],
      langs: [language.toLowerCase()],
      preferredHighlighter: "shiki-js",
    })
      .then((highlighter) => {
        if (!activeLoad) return;
        const tokenized = highlighter.codeToTokens(content, {
          lang: language.toLowerCase(),
          theme,
        });
        if (activeLoad) setHighlight({ content, language, theme, tokens: tokenized.tokens });
      })
      .catch(() => {
        // Unknown languages fall back to plain monospace rendering.
      });
    return () => {
      activeLoad = false;
    };
  }, [readyPreview?.content, readyPreview?.language, theme]);

  const targetStart = active.line;
  const targetEnd =
    active.endLine && targetStart && active.endLine >= targetStart ? active.endLine : targetStart;

  useEffect(() => {
    if (!targetStart || !readyPreview) return;
    targetLineRef.current?.scrollIntoView?.({ block: "center" });
  }, [active.requestId, targetStart, readyPreview]);

  const lines = useMemo(
    () =>
      readyPreview ? (readyPreview.content === "" ? [] : readyPreview.content.split("\n")) : [],
    [readyPreview],
  );
  const tokens =
    readyPreview &&
    highlight?.content === readyPreview.content &&
    highlight.language === readyPreview.language &&
    highlight.theme === theme
      ? highlight.tokens
      : undefined;

  const breadcrumbSegments = useMemo(() => {
    if (readyPreview) return splitPathSegments(readyPreview.displayPath, readyPreview.rootName);
    if (preview) return splitPathSegments(preview.displayPath);
    return splitPathSegments(active.path);
  }, [readyPreview, preview, active.path]);

  const canViewDiff = Boolean(
    readyPreview && onOpenDiff && changedPaths?.has(readyPreview.displayPath),
  );
  const vscodeEditor = editors.find((editor) => editor.id === "vscode");
  const copyTarget = readyPreview?.displayPath ?? preview?.displayPath ?? active.path;
  const isCopied = copiedPath === copyTarget;

  const openExternal = (mode: OpenFileTargetMode) => {
    setActionError(undefined);
    void window.eta
      .openFileTarget({
        workspaceId: active.workspaceId,
        path: active.path,
        ...(active.line ? { line: active.line } : {}),
        ...(active.column ? { column: active.column } : {}),
        mode,
      })
      .catch((cause: unknown) => {
        setActionError(describeError(cause, localizedMessage("chat:markdownLink.cannotOpenFile")));
      });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ToastNotice message={actionError} />
      <InspectorToolbar>
        <div
          role="tablist"
          aria-label={t("inspector:inspectorTabs.files")}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const selected = tab.key === active.key;
            return (
              <div
                key={tab.key}
                className={cn(
                  "group flex h-6 max-w-44 shrink-0 items-center rounded-md border text-xs transition-colors",
                  selected
                    ? "border-border bg-surface text-heading"
                    : "border-transparent text-subtle hover:bg-surface-hover/60 hover:text-heading",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={tab.path}
                  onClick={() => onSelect(tab.key)}
                  className="flex h-full min-w-0 items-center gap-1.5 rounded-l-md px-2 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-400"
                >
                  <FileTypeIcon name={tab.name} size={13} />
                  <span className="truncate">{tab.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("inspector:fileViewer.closeTab", { name: tab.name })}
                  onClick={() => onClose(tab.key)}
                  className={cn(
                    "mr-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted outline-none transition-colors hover:bg-surface-hover hover:text-heading focus-visible:ring-2 focus-visible:ring-focus-ring-400",
                    selected ? "opacity-80" : "opacity-0 group-hover:opacity-80 focus:opacity-100",
                  )}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        {canViewDiff && readyPreview && (
          <Button
            variant="ghost-muted"
            size="icon-tiny"
            aria-label={t("inspector:fileViewer.viewDiff")}
            title={t("inspector:fileViewer.viewDiff")}
            onClick={() => onOpenDiff?.(readyPreview.displayPath)}
          >
            <FileDiff size={14} aria-hidden="true" />
          </Button>
        )}
        <Button
          variant="ghost-muted"
          size="icon-tiny"
          aria-label={t("inspector:fileViewer.refresh")}
          title={t("inspector:fileViewer.refresh")}
          onClick={() => onRefresh(active.key)}
        >
          <RotateCw
            size={13}
            className={loadingIdentity === resourceIdentity ? "animate-spin" : undefined}
            aria-hidden="true"
          />
        </Button>
      </InspectorToolbar>

      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-soft bg-surface-soft/50 px-3">
        <nav
          aria-label={t("inspector:fileViewer.breadcrumb")}
          className="min-w-0 flex-1 overflow-x-auto"
        >
          <ol className="flex items-center gap-1 whitespace-nowrap text-xs text-subtle">
            {breadcrumbSegments.map((segment, index) => {
              const last = index === breadcrumbSegments.length - 1;
              return (
                <li key={`${index}:${segment}`} className="flex items-center gap-1">
                  {index > 0 && (
                    <ChevronRight size={12} className="shrink-0 text-muted" aria-hidden="true" />
                  )}
                  {last ? (
                    <span
                      aria-current="page"
                      className="flex items-center gap-1.5 font-medium text-heading"
                    >
                      <FileTypeIcon name={segment} size={13} />
                      <span>{segment}</span>
                    </span>
                  ) : (
                    <span>{segment}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost-muted"
            size="icon-tiny"
            aria-label={
              isCopied ? t("inspector:fileViewer.copiedPath") : t("inspector:fileViewer.copyPath")
            }
            title={
              isCopied ? t("inspector:fileViewer.copiedPath") : t("inspector:fileViewer.copyPath")
            }
            onClick={() => {
              void navigator.clipboard
                ?.writeText(copyTarget)
                .then(() => setCopiedPath(copyTarget))
                .catch(() => setCopiedPath(undefined));
            }}
          >
            {isCopied ? <Check size={13} /> : <Copy size={13} />}
          </Button>
          {!cloud && (
            <>
              <Button
                variant="ghost-muted"
                size="icon-tiny"
                aria-label={
                  navigator.userAgent.includes("Mac")
                    ? t("chat:markdownLink.showInFinder")
                    : t("chat:markdownLink.showInFileManager")
                }
                title={
                  navigator.userAgent.includes("Mac")
                    ? t("chat:markdownLink.showInFinder")
                    : t("chat:markdownLink.showInFileManager")
                }
                onClick={() => openExternal({ kind: "reveal" })}
              >
                <Folder size={13} aria-hidden="true" />
              </Button>
              {vscodeEditor && (
                <Button
                  variant="ghost-muted"
                  size="icon-tiny"
                  aria-label={t("chat:markdownLink.openInEditor", { name: vscodeEditor.name })}
                  title={t("chat:markdownLink.openInEditor", { name: vscodeEditor.name })}
                  onClick={() => openExternal({ kind: "editor", editorId: vscodeEditor.id })}
                >
                  <Code2 size={13} aria-hidden="true" />
                </Button>
              )}
              <Button
                variant="ghost-muted"
                size="icon-tiny"
                aria-label={t("chat:markdownLink.systemDefaultApp")}
                title={t("chat:markdownLink.systemDefaultApp")}
                onClick={() => openExternal({ kind: "default" })}
              >
                <ExternalLink size={13} aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      </div>

      {readyPreview?.truncated && (
        <div className="shrink-0 border-b border-border-soft bg-warning-tint-50 px-3 py-1 text-[11px] text-warning-text-600">
          {t("inspector:fileViewer.truncated", { lines: readyPreview.totalLines })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-surface">
        {isInitialLoading ? (
          <output className="block p-4 text-xs text-subtle">
            {t("inspector:fileViewer.loading")}
          </output>
        ) : activeError ? (
          <div className="flex items-center gap-2 p-4 text-xs text-subtle">
            <span>{t("inspector:fileViewer.reason.unreadable")}</span>
            <Button variant="ghost" size="toolbar" onClick={() => onRefresh(active.key)}>
              {t("inspector:fileViewer.retry")}
            </Button>
          </div>
        ) : preview?.status === "unavailable" ? (
          <div className="flex flex-col items-start gap-2.5 p-4 text-xs text-subtle">
            <p role="status">{t(`inspector:fileViewer.reason.${preview.reason}`)}</p>
            {!cloud && preview.reason !== "missing" && preview.reason !== "cloud-unsupported" && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => openExternal({ kind: "reveal" })}
                >
                  <Folder size={13} aria-hidden="true" />
                  {navigator.userAgent.includes("Mac")
                    ? t("chat:markdownLink.showInFinder")
                    : t("chat:markdownLink.showInFileManager")}
                </Button>
                {preview.reason === "binary" && (
                  <Button
                    variant="outline"
                    size="compact"
                    onClick={() => openExternal({ kind: "default" })}
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                    {t("chat:markdownLink.systemDefaultApp")}
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : readyPreview ? (
          <div className="min-w-max py-2 font-mono text-[12px]/5 text-foreground">
            {lines.map((line, index) => {
              const lineNumber = index + 1;
              const isHighlighted =
                targetStart !== undefined &&
                targetEnd !== undefined &&
                lineNumber >= targetStart &&
                lineNumber <= targetEnd;
              const lineTokens = tokens?.[index];
              return (
                <div
                  key={lineNumber}
                  ref={lineNumber === targetStart ? targetLineRef : undefined}
                  data-line={lineNumber}
                  data-highlighted-line={isHighlighted ? "true" : undefined}
                  className={cn(
                    "flex items-start px-3",
                    isHighlighted &&
                      "border-l-2 border-info-border-500 bg-info-tint-100/60 pl-[10px]",
                  )}
                >
                  <span className="mr-4 inline-block w-10 shrink-0 select-none text-right tabular-nums text-muted">
                    {lineNumber}
                  </span>
                  <span className="whitespace-pre">
                    {lineTokens
                      ? lineTokens.map((token, tokenIndex) => (
                          <span
                            key={tokenIndex}
                            style={{
                              color: token.color,
                              fontStyle:
                                token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
                            }}
                          >
                            {token.content}
                          </span>
                        ))
                      : line || " "}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
