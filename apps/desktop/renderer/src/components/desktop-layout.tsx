import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
export function DesktopLayout({
  sidebar,
  children,
  collapsed,
  inspectorOpen = false,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  inspectorOpen?: boolean;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#e9e9e9]">
      <div
        className={cn(
          "flex min-h-0 flex-1 pb-[3.5px] transition-[padding-right] duration-180 ease-out motion-reduce:transition-none",
          !inspectorOpen && "pr-[3.5px]",
        )}
      >
        {sidebar}
        <main
          className={cn(
            "flex min-w-0 flex-1 flex-col overflow-hidden bg-white transition-[border-radius] duration-180 ease-out motion-reduce:transition-none",
            !inspectorOpen && "rounded-r-[14px]",
            collapsed && "rounded-l-[14px]",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
