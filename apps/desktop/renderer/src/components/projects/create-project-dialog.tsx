import { useRef, useState } from "react";
import { FolderClosed, FolderPlus, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IconInput } from "@/components/ui/icon-input";
import { Alert } from "@/components/ui/alert";

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (rootPath: string, name: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      {open && (
        <CreateProjectForm
          onClose={() => onOpenChange(false)}
          onCreate={onCreate}
          onBusyChange={setBusy}
        />
      )}
    </Dialog>
  );
}

function CreateProjectForm({
  onClose,
  onCreate,
  onBusyChange,
}: {
  onClose: () => void;
  onCreate: (rootPath: string, name: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [name, setName] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addFolder = async () => {
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const path = await window.eta.chooseDirectory();
      if (!path) return;
      setRootPath(path);
      setName((current) => current || path.split(/[\\/]/).filter(Boolean).at(-1) || "");
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法选择文件夹");
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };
  const create = async () => {
    if (busy || !rootPath || !name.trim()) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      await onCreate(rootPath, name.trim());
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法创建项目");
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };
  return (
    <DialogContent variant="compact-form" initialFocus={nameInput}>
      <form
        className="flex min-h-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <DialogTitle className="text-sm font-medium text-neutral-900">创建项目</DialogTitle>
          <DialogClose
            disabled={busy}
            render={
              <Button variant="ghost" size="icon-xs" aria-label="关闭创建项目">
                <X size={14} aria-hidden="true" />
              </Button>
            }
          />
        </div>
        <IconInput
          variant="compact"
          ref={nameInput}
          icon={<FolderClosed size={16} />}
          aria-label="项目名称"
          placeholder="项目名称"
          value={name}
          onValueChange={setName}
          disabled={busy}
          required
        />
        <section className="flex flex-col gap-1.5" aria-labelledby="project-source-label">
          <h2 id="project-source-label" className="text-xs font-medium text-neutral-800">
            源文件夹
          </h2>
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 py-2">
            {rootPath ? (
              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-neutral-700">
                <FolderClosed size={16} className="shrink-0" aria-hidden="true" />
                <span className="truncate" title={rootPath}>
                  {rootPath}
                </span>
              </div>
            ) : (
              <p className="min-w-0 flex-1 text-xs text-neutral-500">在此电脑上添加文件夹</p>
            )}
            <Button
              variant="secondary"
              size="compact"
              disabled={busy}
              onClick={() => void addFolder()}
            >
              <FolderPlus size={14} aria-hidden="true" />
              {rootPath ? "更换文件夹" : "添加"}
            </Button>
          </div>
        </section>
        {error && <Alert>{error}</Alert>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost-muted" size="compact" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button size="compact" type="submit" disabled={busy || !rootPath || !name.trim()}>
            {busy ? "请稍候…" : "创建项目"}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
