import type { ReactNode } from "react";
export function Kbd({
  children,
  variant = "plain",
}: {
  children: ReactNode;
  variant?: "plain" | "badge";
}) {
  return (
    <kbd
      className={
        variant === "badge"
          ? "shrink-0 rounded-full bg-neutral-200/60 px-1.5 font-sans text-xs text-neutral-500"
          : "font-sans text-[10px] text-neutral-400"
      }
    >
      {children}
    </kbd>
  );
}
