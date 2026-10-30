import { useId, type ReactNode } from "react";
import { t } from "@/i18n";
import { useInspectorWidth } from "@/components/inspector/use-inspector-width";
import { useInspectorMinimumWidth } from "@/components/inspector/desktop-inspector";

function filePaneBounds(available: number) {
  const max = Math.max(0, available - 80);
  return { min: Math.min(112, max), max };
}

export function DiffFilePane({ children }: { children: ReactNode }) {
  const id = useId();
  const resize = useInspectorWidth<HTMLDivElement>(true, {
    storageKey: "eta.diff-tree-width.v1",
    defaultWidth: 240,
    bounds: filePaneBounds,
  });
  useInspectorMinimumWidth(resize.width + 80);
  return (
    <div
      ref={resize.ref}
      style={{ width: resize.width }}
      className="relative min-h-0 min-w-0 shrink-0 overflow-hidden border-l border-neutral-200/70 bg-neutral-50 dark:border-neutral-800 dark:bg-[#141414]"
    >
      <div
        role="separator"
        tabIndex={0}
        aria-label={t("diff:resizeFiles")}
        aria-orientation="vertical"
        aria-controls={id}
        aria-valuemin={resize.min}
        aria-valuemax={resize.max}
        aria-valuenow={resize.width}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none focus-visible:border-l focus-visible:border-sky-500 focus-visible:outline-none"
        onPointerDown={resize.onPointerDown}
        onPointerMove={resize.onPointerMove}
        onPointerUp={resize.onPointerUp}
        onPointerCancel={resize.onPointerCancel}
        onLostPointerCapture={resize.onLostPointerCapture}
        onKeyDown={resize.onKeyDown}
      />
      <nav
        id={id}
        aria-label={t("diff:files")}
        className="h-full min-w-0 overflow-y-auto px-1 pt-8 pb-1"
      >
        {children}
      </nav>
    </div>
  );
}
