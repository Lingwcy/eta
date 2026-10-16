import { renderMessage } from "@/i18n/messages";
import { describeError, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { isCloudId, sameEnvironment } from "../../../../src/shared/bot.ts";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Clock,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  FileText,
  Folder,
  FolderMinus,
  FolderSymlink,
  Pencil,
  Trash2,
  AppWindow,
} from "lucide-react";
import type { DesktopLibraryController } from "@/agent/use-desktop-library";
import type { ThreadMetadata } from "@eta/core/shared/threads";
import { threadProjectId } from "@eta/core/shared/thread-project";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSubmenu,
  ContextMenuSubmenuTrigger,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";

type Edit = { kind: "rename" | "delete"; thread: ThreadMetadata };
const Actions = createContext<{
  desktop: DesktopLibraryController;
  edit: (value: Edit) => void;
  schedule?: (id: string) => void;
  overlay: (open: boolean) => void;
} | null>(null);

export function ThreadActionsProvider({
  desktop,
  onOverlay,
  onSchedule,
  children,
}: {
  desktop: DesktopLibraryController;
  onOverlay: (open: boolean) => void;
  onSchedule?: (id: string) => void;
  children: ReactNode;
}) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    onOverlay(menuOpen || !!edit);
  }, [menuOpen, edit, onOverlay]);
  return (
    <Actions.Provider
      value={{ desktop, edit: setEdit, overlay: setMenuOpen, schedule: onSchedule }}
    >
      {children}
      <Dialog
        open={!!edit}
        onOpenChange={(open) => {
          if (!open) setEdit(null);
        }}
      >
        {edit && (
          <ThreadEditForm
            key={`${edit.kind}:${edit.thread.id}`}
            edit={edit}
            onClose={() => setEdit(null)}
            onSaved={desktop.reload}
          />
        )}
      </Dialog>
    </Actions.Provider>
  );
}

export function ThreadContextMenu({
  id,
  children,
  onScheduleOpen,
}: {
  id?: string;
  children: ReactElement;
  onScheduleOpen?: () => void;
}) {
  useTranslation();
  const actions = useContext(Actions);
  const thread = actions?.desktop.library?.threads.find((thread) => thread.id === id);
  if (!actions || !thread || !actions.desktop.library) return children;
  const { desktop, edit, overlay } = actions;
  const library = desktop.library!;
  const projectId = threadProjectId(thread, library);
  const run = (action: () => Promise<unknown>) =>
    void desktop.act(async () => {
      await action();
    });
  return (
    <ContextMenu onOpenChange={overlay}>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent>
        {actions.schedule && thread.archivedAt === undefined && (
          <ContextMenuItem
            disabled={desktop.busy}
            onClick={() => {
              onScheduleOpen?.();
              actions.schedule?.(thread.id);
            }}
          >
            <Clock size={16} />
            {t("chat:threadActions.addScheduledTask")}
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={desktop.busy} onClick={() => edit({ kind: "rename", thread })}>
          <Pencil size={16} />
          {t("chat:threadActions.rename")}
        </ContextMenuItem>
        <ContextMenuSubmenu>
          <ContextMenuSubmenuTrigger disabled={desktop.busy}>
            <FolderSymlink size={16} />
            {t("chat:threadActions.projects")}
          </ContextMenuSubmenuTrigger>
          <ContextMenuContent submenu>
            {library.projects
              .filter((project) => sameEnvironment(thread.id, project.id))
              .map((project) => (
                <ContextMenuItem
                  key={project.id}
                  title={project.name}
                  disabled={project.id === projectId}
                  onClick={() => run(() => window.eta.moveThread(thread.id, project.id))}
                >
                  <Folder size={16} />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                </ContextMenuItem>
              ))}
            {projectId && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => run(() => window.eta.moveThread(thread.id, null))}>
                  <FolderMinus size={16} />
                  {t("chat:threadActions.removeFromProject")}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenuSubmenu>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={desktop.busy}
          onClick={() => run(() => window.eta.openThreadWindow(thread.id))}
        >
          <AppWindow size={16} />
          {t("chat:threadActions.openInNewWindow")}
        </ContextMenuItem>
        <ContextMenuSubmenu>
          <ContextMenuSubmenuTrigger disabled={desktop.busy || isCloudId(thread.id)}>
            <ArrowUpRight size={16} />
            {t("chat:threadActions.openWith")}
          </ContextMenuSubmenuTrigger>
          <ContextMenuContent submenu>
            <ContextMenuItem
              onClick={() => run(() => window.eta.openThreadFile(thread.id, "default"))}
            >
              <FileText size={16} />
              {t("chat:threadActions.systemDefaultApp")}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => run(() => window.eta.openThreadFile(thread.id, "reveal"))}
            >
              <Folder size={16} />
              {navigator.userAgent.includes("Mac")
                ? t("chat:threadActions.showInFinder")
                : t("chat:threadActions.showInFileManager")}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => run(() => window.eta.openThreadFile(thread.id, "choose"))}
            >
              <ArrowUpRight size={16} />
              {t("chat:threadActions.chooseAnotherApp")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuSubmenu>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={desktop.busy}
          onClick={() =>
            run(() => window.eta.archiveThread(thread.id, thread.archivedAt === undefined))
          }
        >
          {thread.archivedAt === undefined ? <Archive size={16} /> : <ArchiveRestore size={16} />}
          {thread.archivedAt === undefined
            ? t("chat:threadActions.archive")
            : t("chat:threadActions.resume")}
        </ContextMenuItem>
        <ContextMenuItem
          destructive
          disabled={desktop.busy}
          onClick={() => edit({ kind: "delete", thread })}
        >
          <Trash2 size={16} />
          {t("chat:threadActions.deletePermanently")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ThreadEditForm({
  edit,
  onClose,
  onSaved,
}: {
  edit: Edit;
  onClose: () => void;
  onSaved: () => void;
}) {
  useTranslation();
  const [title, setTitle] = useState(edit.thread.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message>();
  const deleting = edit.kind === "delete";
  const save = async () => {
    if (busy || (!deleting && !title.trim())) return;
    setBusy(true);
    setError(undefined);
    try {
      if (deleting) await window.eta.deleteThread(edit.thread.id);
      else await window.eta.renameThread(edit.thread.id, title);
      onSaved();
      onClose();
    } catch (error) {
      setError(describeError(error, String(error)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogContent variant="form">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <DialogTitle className="text-lg font-semibold">
          {deleting
            ? t("chat:threadActions.deleteChatPermanently")
            : t("chat:threadActions.renameChat")}
        </DialogTitle>
        {deleting ? (
          <p className="text-sm text-neutral-500">
            {t("navigation:threadActions.deleteDescription", { title: edit.thread.title })}
          </p>
        ) : (
          <Input
            aria-label={t("chat:threadActions.chatName")}
            value={title}
            onValueChange={setTitle}
            disabled={busy}
          />
        )}
        {error && <Alert>{renderMessage(error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {t("chat:threadActions.cancel")}
          </Button>
          <Button
            variant={deleting ? "ghost-destructive" : "default"}
            size="sm"
            type="submit"
            disabled={busy || (!deleting && !title.trim())}
          >
            {busy
              ? t("chat:threadActions.processing")
              : deleting
                ? t("chat:threadActions.deletePermanently")
                : t("chat:threadActions.save")}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
