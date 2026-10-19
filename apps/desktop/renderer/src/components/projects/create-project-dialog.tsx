import { renderMessage } from "@/i18n/messages";
import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
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
  cloud = false,
  cloudRoot,
}: {
  open: boolean;
  cloud?: boolean;
  cloudRoot?: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (rootPath: string, name: string, requestId: string) => Promise<void>;
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
          cloud={cloud}
          cloudRoot={cloudRoot}
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
  cloud,
  cloudRoot,
}: {
  cloud: boolean;
  cloudRoot?: string;
  onClose: () => void;
  onCreate: (rootPath: string, name: string, requestId: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  useTranslation();
  const [name, setName] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  /** A retry of the same project must reuse the identity its first attempt may have committed. */
  const attempt = useRef<{ key: string; requestId: string } | undefined>(undefined);
  const [rootPath, setRootPath] = useState<string | null>(cloud ? (cloudRoot ?? null) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
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
      setError(
        describeError(
          error,
          localizedMessage("navigation:createProjectDialog.cannotChooseAFolder"),
        ),
      );
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };
  const create = async () => {
    if (busy || (!cloud && !rootPath) || !name.trim()) return;
    const key = JSON.stringify([rootPath ?? "", name.trim()]);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: crypto.randomUUID() };
    const requestId = attempt.current.requestId;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      await onCreate(rootPath ?? "", name.trim(), requestId);
      attempt.current = undefined;
      onClose();
    } catch (error) {
      setError(
        describeError(
          error,
          localizedMessage("navigation:createProjectDialog.cannotCreateTheProject"),
        ),
      );
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
          <DialogTitle className="text-sm font-medium text-neutral-900">
            {cloud
              ? t("navigation:createProjectDialog.createCloudProject")
              : t("navigation:createProjectDialog.createProject")}
          </DialogTitle>
          <DialogClose
            disabled={busy}
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("navigation:createProjectDialog.closeProjectCreation")}
              >
                <X size={14} aria-hidden="true" />
              </Button>
            }
          />
        </div>
        <IconInput
          variant="compact"
          ref={nameInput}
          icon={<FolderClosed size={16} />}
          aria-label={t("navigation:createProjectDialog.projectName")}
          placeholder={t("navigation:createProjectDialog.projectName")}
          value={name}
          onValueChange={setName}
          disabled={busy}
          required
        />
        {cloud ? (
          <p className="text-xs break-words text-neutral-500">
            {t("navigation:createProjectDialog.createAFolderWithThisNameUnder")}
            {cloudRoot ? t("navigation:createProjectDialog.cloudRoot", { path: cloudRoot }) : ""}
          </p>
        ) : (
          <section className="flex flex-col gap-1.5" aria-labelledby="project-source-label">
            <h2 id="project-source-label" className="text-xs font-medium text-neutral-800">
              {t("navigation:createProjectDialog.sourceFolder")}
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
                <p className="min-w-0 flex-1 text-xs text-neutral-500">
                  {t("navigation:createProjectDialog.addAFolderOnThisComputer")}
                </p>
              )}
              <Button
                variant="secondary"
                size="compact"
                disabled={busy}
                onClick={() => void addFolder()}
              >
                <FolderPlus size={14} aria-hidden="true" />
                {rootPath
                  ? t("navigation:createProjectDialog.changeFolder")
                  : t("navigation:createProjectDialog.add")}
              </Button>
            </div>
          </section>
        )}
        {error && <Alert>{renderMessage(error)}</Alert>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost-muted" size="compact" disabled={busy} onClick={onClose}>
            {t("navigation:createProjectDialog.cancel")}
          </Button>
          <Button
            size="compact"
            type="submit"
            disabled={busy || (!cloud && !rootPath) || !name.trim()}
          >
            {busy
              ? t("navigation:createProjectDialog.pleaseWait")
              : t("navigation:createProjectDialog.createProject")}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
