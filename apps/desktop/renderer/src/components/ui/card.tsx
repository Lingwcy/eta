import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/70 bg-surface px-4 [&>*+*]:border-t [&>*+*]:border-border-soft",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
