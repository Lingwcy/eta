import type { ReactNode } from "react";
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="font-sans text-[10px] text-neutral-400">{children}</kbd>;
}
