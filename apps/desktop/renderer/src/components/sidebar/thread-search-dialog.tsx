import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { lazy, Suspense, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { SearchDialogProps } from "./search-dialog-props";

const ThreadSearchContent = lazy(() =>
  import("./thread-search-content").then((module) => ({ default: module.ThreadSearchContent })),
);

export function ThreadSearchDialog(props: SearchDialogProps) {
  useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            title={t("navigation:threadSearchDialog.searchChats")}
            aria-label={t("navigation:threadSearchDialog.searchChats")}
          />
        }
      >
        <Search size={16} aria-hidden="true" />
      </DialogTrigger>
      {open && (
        <Suspense
          fallback={
            <DialogContent>
              <DialogTitle className="sr-only">
                {t("navigation:threadSearchDialog.searchChats")}
              </DialogTitle>
              <p className="p-4 text-sm text-neutral-400">
                {t("navigation:threadSearchDialog.loadingSearch")}
              </p>
            </DialogContent>
          }
        >
          <ThreadSearchContent {...props} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </Dialog>
  );
}
