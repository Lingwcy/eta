import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
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
import type { ThreadMetadata } from "../../../../src/shared/threads.ts";
import { threadProjectId } from "../../../../src/shared/thread-project.ts";
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
  overlay: (open: boolean) => void;
} | null>(null);

export function ThreadActionsProvider({
  desktop,
  onOverlay,
  children,
}: {
  desktop: DesktopLibraryController;
  onOverlay: (open: boolean) => void;
  children: ReactNode;
}) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    onOverlay(menuOpen || !!edit);
  }, [menuOpen, edit, onOverlay]);
  return (
    <Actions.Provider value={{ desktop, edit: setEdit, overlay: setMenuOpen }}>
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

export function ThreadContextMenu({ id, children }: { id?: string; children: ReactElement }) {
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
        <ContextMenuItem disabled={desktop.busy} onClick={() => edit({ kind: "rename", thread })}>
          <Pencil size={16} />
          重命名
        </ContextMenuItem>
        <ContextMenuSubmenu>
          <ContextMenuSubmenuTrigger disabled={desktop.busy}>
            <FolderSymlink size={16} />
            项目
          </ContextMenuSubmenuTrigger>
          <ContextMenuContent submenu>
            {library.projects.map((project) => (
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
                  从项目中移除
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
          在新窗口中打开
        </ContextMenuItem>
        <ContextMenuSubmenu>
          <ContextMenuSubmenuTrigger disabled={desktop.busy}>
            <ArrowUpRight size={16} />
            打开方式
          </ContextMenuSubmenuTrigger>
          <ContextMenuContent submenu>
            <ContextMenuItem
              onClick={() => run(() => window.eta.openThreadFile(thread.id, "default"))}
            >
              <FileText size={16} />
              系统默认应用
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => run(() => window.eta.openThreadFile(thread.id, "reveal"))}
            >
              <Folder size={16} />
              {navigator.userAgent.includes("Mac") ? "在 Finder 中查看" : "在文件管理器中查看"}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => run(() => window.eta.openThreadFile(thread.id, "choose"))}
            >
              <ArrowUpRight size={16} />
              选择其他应用…
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
          {thread.archivedAt === undefined ? "归档" : "恢复"}
        </ContextMenuItem>
        <ContextMenuItem
          destructive
          disabled={desktop.busy}
          onClick={() => edit({ kind: "delete", thread })}
        >
          <Trash2 size={16} />
          永久删除
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
  const [title, setTitle] = useState(edit.thread.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
      setError(error instanceof Error ? error.message : String(error));
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
          {deleting ? "永久删除会话？" : "重命名会话"}
        </DialogTitle>
        {deleting ? (
          <p className="text-sm text-neutral-500">
            “{edit.thread.title}”的会话记录与子任务数据将被删除，无法恢复。项目文件会保留。
          </p>
        ) : (
          <Input aria-label="会话名称" value={title} onValueChange={setTitle} disabled={busy} />
        )}
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant={deleting ? "ghost-destructive" : "default"}
            size="sm"
            type="submit"
            disabled={busy || (!deleting && !title.trim())}
          >
            {busy ? "处理中…" : deleting ? "永久删除" : "保存"}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
