import { createContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  CircleDot,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  FileText,
  Folder,
  Github,
  GitPullRequest,
  Globe2,
} from "lucide-react";
import { useMarkdownActions } from "@/agent/markdown-actions";
import { FileTypeIcon } from "@/components/files/file-type-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubmenu,
  ContextMenuSubmenuTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { t } from "@/i18n";
import {
  formatFileLineSuffix,
  type FileReference,
  type MarkdownLinkTarget,
} from "./markdown-targets";

export const InsideMarkdownLinkContext = createContext(false);

const fileChipClass =
  "inline-flex max-w-full cursor-pointer items-center gap-1 rounded-[5px] border border-border-soft bg-surface-subtle/80 px-1.5 py-px align-baseline text-[0.88em] leading-[1.35] text-heading transition-colors hover:border-border hover:bg-surface-hover/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const githubChipClass =
  "inline-flex max-w-full items-center gap-1 rounded-[5px] border border-border-soft bg-surface-subtle/80 px-1.5 py-px align-baseline text-[0.88em] leading-[1.35] font-medium text-heading no-underline transition-colors hover:border-border hover:bg-surface-hover/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const webLinkClass =
  "text-info-text-600 underline decoration-info-text-600/40 underline-offset-2 hover:decoration-info-text-600 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info-text-600";

function copyText(text: string, onError?: (error: unknown) => void) {
  void navigator.clipboard?.writeText(text).catch((error: unknown) => onError?.(error));
}

function isAutolinkText(children: ReactNode, url: string) {
  if (typeof children !== "string") return false;
  const trimmed = children.trim().replace(/\/+$/, "");
  const normalizedUrl = url.trim().replace(/\/+$/, "");
  return trimmed === "" || trimmed === normalizedUrl;
}

export function FileLinkBlock({
  file,
  label,
  showLineSuffix = false,
  preview = false,
}: {
  file: FileReference;
  label: ReactNode;
  showLineSuffix?: boolean;
  preview?: boolean;
}) {
  useTranslation();
  const actions = useMarkdownActions();
  const suffix = showLineSuffix ? formatFileLineSuffix(file) : "";
  const fullTarget = `${file.path}${formatFileLineSuffix(file)}`;

  const inner = (
    <InsideMarkdownLinkContext.Provider value={true}>
      <FileTypeIcon name={file.name} size={13} />
      <span className="min-w-0 truncate">
        {label}
        {suffix}
      </span>
    </InsideMarkdownLinkContext.Provider>
  );

  if (preview) {
    return (
      <span className={fileChipClass} data-markdown-block="file" title={fullTarget}>
        {inner}
      </span>
    );
  }

  const trigger = (
    <button
      type="button"
      data-markdown-block="file"
      data-file-path={file.path}
      title={fullTarget}
      className={fileChipClass}
      onClick={() =>
        actions?.openFile({
          workspaceId: actions.workspaceId,
          path: file.path,
          line: file.line,
          endLine: file.endLine,
          column: file.column,
        })
      }
    >
      {inner}
    </button>
  );

  if (!actions) return trigger;

  const vscodeEditor = actions.editors.find((editor) => editor.id === "vscode");
  const otherEditors = actions.editors.filter((editor) => editor.id !== "vscode");
  const runExternal = (mode: Parameters<typeof actions.openFileExternal>[0]["mode"]) => {
    void actions
      .openFileExternal({
        path: file.path,
        line: file.line,
        column: file.column,
        mode,
      })
      .catch((error: unknown) => actions.onError?.(error));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} />
      <ContextMenuContent size="auto">
        <ContextMenuItem
          onClick={() =>
            actions.openFile({
              workspaceId: actions.workspaceId,
              path: file.path,
              line: file.line,
              endLine: file.endLine,
              column: file.column,
            })
          }
        >
          <FileCode2 size={14} />
          {t("chat:markdownLink.openInEta")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {vscodeEditor && (
          <ContextMenuItem
            disabled={actions.cloud}
            onClick={() => runExternal({ kind: "editor", editorId: vscodeEditor.id })}
          >
            <Code2 size={14} />
            <span className="min-w-0 truncate">
              {t("chat:markdownLink.openInEditor", { name: vscodeEditor.name })}
            </span>
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={actions.cloud} onClick={() => runExternal({ kind: "reveal" })}>
          <Folder size={14} />
          {navigator.userAgent.includes("Mac")
            ? t("chat:markdownLink.showInFinder")
            : t("chat:markdownLink.showInFileManager")}
        </ContextMenuItem>
        <ContextMenuSubmenu>
          <ContextMenuSubmenuTrigger disabled={actions.cloud}>
            <ArrowUpRight size={14} />
            {t("chat:markdownLink.openWith")}
          </ContextMenuSubmenuTrigger>
          <ContextMenuContent submenu size="auto">
            {otherEditors.map((editor) => (
              <ContextMenuItem
                key={editor.id}
                onClick={() => runExternal({ kind: "editor", editorId: editor.id })}
              >
                <Code2 size={14} />
                <span className="min-w-0 truncate">
                  {t("chat:markdownLink.openInEditor", { name: editor.name })}
                </span>
              </ContextMenuItem>
            ))}
            {otherEditors.length > 0 && <ContextMenuSeparator />}
            <ContextMenuItem onClick={() => runExternal({ kind: "default" })}>
              <FileText size={14} />
              {t("chat:markdownLink.systemDefaultApp")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => runExternal({ kind: "choose" })}>
              <ArrowUpRight size={14} />
              {t("chat:markdownLink.chooseAnotherApp")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuSubmenu>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => copyText(fullTarget, actions.onError)}>
          <Copy size={14} />
          {t("chat:markdownLink.copyPath")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function WebContextMenu({
  url,
  showGitHubPanel,
  trigger,
}: {
  url: string;
  showGitHubPanel: boolean;
  trigger: React.ReactElement;
}) {
  useTranslation();
  const actions = useMarkdownActions();
  if (!actions) return trigger;

  const openExternal = () => {
    void actions.openWebExternal(url).catch((error: unknown) => actions.onError?.(error));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} />
      <ContextMenuContent size="auto">
        <ContextMenuItem onClick={() => actions.openWebInBrowser(url)}>
          <Globe2 size={14} />
          {t("chat:markdownLink.openInBuiltInBrowser")}
        </ContextMenuItem>
        <ContextMenuItem onClick={openExternal}>
          <ExternalLink size={14} />
          {t("chat:markdownLink.openInExternalBrowser")}
        </ContextMenuItem>
        {showGitHubPanel && actions.openGitHubPanel && (
          <ContextMenuItem onClick={() => actions.openGitHubPanel?.()}>
            <Github size={14} />
            {t("chat:markdownLink.viewInGithubPanel")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => copyText(url, actions.onError)}>
          <Copy size={14} />
          {t("chat:markdownLink.copyLink")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function GitHubReferenceBlock({
  target,
  children,
  preview = false,
}: {
  target: Extract<MarkdownLinkTarget, { kind: "github-pr" | "github-issue" }>;
  children: ReactNode;
  preview?: boolean;
}) {
  const actions = useMarkdownActions();
  const Icon = target.kind === "github-pr" ? GitPullRequest : CircleDot;
  const displayLabel = isAutolinkText(children, target.url) ? target.label : children;

  const content = (
    <InsideMarkdownLinkContext.Provider value={true}>
      <Icon size={13} className="shrink-0 text-success-text-600" aria-hidden="true" />
      <span className="min-w-0 truncate">{displayLabel}</span>
    </InsideMarkdownLinkContext.Provider>
  );

  if (preview) {
    return (
      <span className={githubChipClass} data-markdown-block={target.kind} title={target.url}>
        {content}
      </span>
    );
  }

  const trigger = (
    <a
      href={target.url}
      target="_blank"
      rel="noopener noreferrer"
      data-markdown-block={target.kind}
      title={target.url}
      className={githubChipClass}
      onClick={(event) => {
        if (!actions) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
          return;
        event.preventDefault();
        actions.openWebInBrowser(target.url);
      }}
    >
      {content}
    </a>
  );

  return <WebContextMenu url={target.url} showGitHubPanel={true} trigger={trigger} />;
}

export function WebLinkBlock({
  target,
  children,
  preview = false,
}: {
  target: Extract<MarkdownLinkTarget, { kind: "web" }>;
  children: ReactNode;
  preview?: boolean;
}) {
  const actions = useMarkdownActions();

  if (preview) {
    return (
      <span className={webLinkClass} data-markdown-block="web">
        {children}
      </span>
    );
  }

  const trigger = (
    <a
      href={target.url}
      target="_blank"
      rel="noopener noreferrer"
      data-markdown-block="web"
      className={webLinkClass}
      onClick={(event) => {
        if (!actions) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
          return;
        event.preventDefault();
        actions.openWebInBrowser(target.url);
      }}
    >
      <InsideMarkdownLinkContext.Provider value={true}>
        {children}
      </InsideMarkdownLinkContext.Provider>
    </a>
  );

  return <WebContextMenu url={target.url} showGitHubPanel={false} trigger={trigger} />;
}
