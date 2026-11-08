import type { ReactNode } from "react";
export function Status({
  icon,
  children,
  detail,
}: {
  icon: ReactNode;
  children: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <output className="flex items-center gap-2.5 text-sm font-medium text-subtle select-none">
      <span className="shrink-0 text-muted" aria-hidden="true">
        {icon}
      </span>
      {children}
      {detail && <span className="font-mono text-xs text-muted tabular-nums">{detail}</span>}
    </output>
  );
}
