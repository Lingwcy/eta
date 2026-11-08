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
          ? "shrink-0 rounded-full bg-surface-hover/60 px-1.5 font-sans text-xs text-subtle"
          : "font-sans text-[11px] text-secondary"
      }
    >
      {children}
    </kbd>
  );
}
