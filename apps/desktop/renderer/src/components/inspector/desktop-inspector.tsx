import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A desktop-wide content slot; opening it shares layout space with every main tab. */
export function DesktopInspector({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <aside
      id="desktop-inspector"
      aria-label="右侧栏"
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "flex min-h-0 min-w-0 max-w-[35%] shrink-0 flex-col overflow-hidden bg-[#e9e9e9] transition-[width] duration-180 ease-out motion-reduce:transition-none",
        open ? "w-[calc(var(--sidebar-width)+3.5px)]" : "w-0",
      )}
    >
      <div className="mr-[3.5px] mb-[3.5px] flex min-h-0 w-[var(--sidebar-width)] flex-1 flex-col rounded-r-[14px] bg-[#f8f8f8]">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </aside>
  );
}
