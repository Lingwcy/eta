import type { ComponentProps, ReactNode } from "react";
import { Input } from "./input";

export function IconInput({
  icon,
  ...props
}: Omit<ComponentProps<typeof Input>, "className" | "variant"> & { icon: ReactNode }) {
  return (
    <div className="flex items-center overflow-hidden rounded-xl border border-neutral-200 bg-white focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
      <span
        className="flex size-11 shrink-0 items-center justify-center border-r border-neutral-200 text-neutral-700"
        aria-hidden="true"
      >
        {icon}
      </span>
      <Input variant="embedded" {...props} />
    </div>
  );
}
