import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useInspectorWidth } from "./use-inspector-width";

/** A desktop-wide content slot; opening it shares layout space with every main tab. */
export function DesktopInspector({ open, children }: { open: boolean; children: ReactNode }) {
  useTranslation();
  const resize = useInspectorWidth(open);
  return (
    <aside
      ref={resize.ref}
      id="desktop-inspector"
      aria-label={t("inspector:desktopInspector.rightSidebar")}
      aria-hidden={!open}
      inert={!open}
      style={{ width: open ? resize.width : 0 }}
      className={cn(
        "relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-[#e9e9e9]",
        !resize.dragging &&
          "transition-[width] duration-180 ease-out motion-reduce:transition-none",
      )}
    >
      {open && (
        <div
          role="separator"
          tabIndex={0}
          aria-label={t("inspector:desktopInspector.resizeSidebar")}
          aria-orientation="vertical"
          aria-controls="desktop-inspector"
          aria-valuemin={resize.min}
          aria-valuemax={resize.max}
          aria-valuenow={resize.width}
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none focus-visible:bg-black/10 focus-visible:outline-none"
          onPointerDown={resize.onPointerDown}
          onPointerMove={resize.onPointerMove}
          onPointerUp={resize.onPointerUp}
          onPointerCancel={resize.onPointerCancel}
          onLostPointerCapture={resize.onLostPointerCapture}
          onKeyDown={resize.onKeyDown}
        />
      )}
      <div className="mr-[3.5px] mb-[3.5px] ml-[3.5px] flex min-h-0 min-w-0 flex-1 flex-col rounded-r-[14px] bg-[#f8f8f8]">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </aside>
  );
}
