import { Search } from "lucide-react";
import type { ComponentProps } from "react";
import { Input } from "./input";

export function SearchInput(props: Omit<ComponentProps<typeof Input>, "variant" | "className">) {
  return (
    <div className="relative">
      <Search
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-neutral-400"
      />
      <Input variant="search" {...props} />
    </div>
  );
}
