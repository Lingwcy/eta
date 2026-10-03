import { lazy, Suspense, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { SearchDialogProps } from "./search-dialog-props";

const ThreadSearchContent = lazy(() =>
  import("./thread-search-content").then((module) => ({ default: module.ThreadSearchContent })),
);

export function ThreadSearchDialog(props: SearchDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost-muted" size="icon-xs" title="搜索聊天" aria-label="搜索聊天" />
        }
      >
        <Search size={16} aria-hidden="true" />
      </DialogTrigger>
      {open && (
        <Suspense
          fallback={
            <DialogContent>
              <DialogTitle className="sr-only">搜索聊天</DialogTitle>
              <p className="p-4 text-sm text-neutral-400">正在加载搜索…</p>
            </DialogContent>
          }
        >
          <ThreadSearchContent {...props} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </Dialog>
  );
}
