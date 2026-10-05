import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;
export const DialogTitle = BaseDialog.Title;

export function DialogContent({
  className,
  variant = "default",
  ...props
}: Omit<ComponentProps<typeof BaseDialog.Popup>, "className"> & {
  className?: string;
  variant?: "default" | "form" | "compact-form";
}) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-30 bg-black/15 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none" />
      <BaseDialog.Popup
        className={cn(
          "fixed top-[10dvh] left-1/2 z-40 flex max-h-[80dvh] w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-black/5 outline-none transition-[opacity,scale] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 motion-reduce:transition-none",
          className,
          variant === "form" && "top-1/2 max-w-[600px] -translate-y-1/2 bg-neutral-50 p-6",
          variant === "compact-form" &&
            "top-1/2 max-w-[420px] -translate-y-1/2 overflow-y-auto rounded-xl border border-black/12 bg-[#f8f8f8] p-4 shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] ring-0",
        )}
        {...props}
      />
    </BaseDialog.Portal>
  );
}
