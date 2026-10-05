import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type InputProps = Omit<ComponentProps<typeof BaseInput>, "className"> & {
  className?: string;
  variant?: "default" | "search" | "embedded" | "embedded-compact";
};

export function Input({ className, variant = "default", ...props }: InputProps) {
  return (
    <BaseInput
      data-slot="input"
      className={cn(
        "w-full min-w-0 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-neutral-400 focus:ring-2 focus:ring-neutral-200 disabled:opacity-50",
        variant === "search" &&
          "rounded-full border-transparent bg-neutral-100 py-2 pl-9 focus:bg-white",
        variant === "embedded" && "h-11 rounded-none border-0 focus:ring-0",
        variant === "embedded-compact" &&
          "h-8 rounded-none border-0 px-2.5 py-0 text-xs focus:ring-0",
        className,
      )}
      {...props}
    />
  );
}
