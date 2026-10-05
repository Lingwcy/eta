import type { ComponentProps, ReactNode } from "react";
import { Input } from "./input";
import { cn } from "@/lib/utils";

export function IconInput({
  icon,
  variant = "default",
  ...props
}: Omit<ComponentProps<typeof Input>, "className" | "variant"> & {
  icon: ReactNode;
  variant?: "default" | "compact";
}) {
  return (
    <div
      className={cn(
        "flex items-center overflow-hidden border border-neutral-200 bg-white focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500",
        variant === "compact" ? "rounded-lg" : "rounded-xl",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center border-r border-neutral-200 text-neutral-700",
          variant === "compact" ? "size-8" : "size-11",
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <Input variant={variant === "compact" ? "embedded-compact" : "embedded"} {...props} />
    </div>
  );
}
