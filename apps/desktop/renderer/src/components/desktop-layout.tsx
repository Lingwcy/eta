import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
export function DesktopLayout({
  toolbar,
  sidebar,
  children,
  collapsed,
}: {
  toolbar: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  collapsed: boolean;
}) {
  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#e9e9e9] font-sans text-[#292b2e] antialiased">
      {toolbar}
      <div className="flex min-h-0 flex-1 pr-[7px] pb-[7px]">
        {sidebar}
        <main
          className={cn(
            "flex min-w-0 flex-1 flex-col overflow-hidden rounded-r-[14px] bg-white",
            collapsed && "rounded-l-[14px]",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
