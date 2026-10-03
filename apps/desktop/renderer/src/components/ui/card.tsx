import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-neutral-200/70 bg-white px-4 [&>*+*]:border-t [&>*+*]:border-neutral-100",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
