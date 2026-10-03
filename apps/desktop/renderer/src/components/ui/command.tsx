import { Autocomplete } from "@base-ui/react/autocomplete";
import type { ComponentProps, ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaContent,
  ScrollAreaScrollbar,
} from "./scroll-area";

export const Command = Autocomplete.Root;
export const CommandGroup = Autocomplete.Group;

export function CommandInput({
  variant = "default",
  ...props
}: Omit<ComponentProps<typeof Autocomplete.Input>, "className"> & {
  variant?: "default" | "search";
}) {
  return (
    <div className="relative w-full shrink-0">
      {variant === "search" && (
        <Search
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-neutral-400"
        />
      )}
      <Autocomplete.Input
        className={cn(
          "w-full border-0 bg-transparent px-4 pt-4 pb-3 text-[15px] text-neutral-800 outline-none placeholder:text-neutral-400",
          variant === "search" && "h-11 py-0 pl-9 text-sm",
        )}
        {...props}
      />
    </div>
  );
}
export function CommandList({
  children,
  size = "default",
  ...props
}: Omit<ComponentProps<typeof Autocomplete.List>, "className" | "children"> & {
  children?: ReactNode;
  size?: "default" | "compact";
}) {
  return (
    <ScrollAreaRoot className="min-h-0 flex-1">
      <ScrollAreaViewport
        tabIndex={-1}
        className={
          size === "compact"
            ? "h-auto max-h-[min(280px,calc(var(--available-height)-100px))]"
            : "h-auto max-h-[calc(80dvh-64px)]"
        }
        render={<Autocomplete.List {...props} role="listbox" />}
      >
        <ScrollAreaContent className="pb-3 pl-1.5">{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar />
    </ScrollAreaRoot>
  );
}
export function CommandGroupLabel(
  props: Omit<ComponentProps<typeof Autocomplete.GroupLabel>, "className">,
) {
  return (
    <Autocomplete.GroupLabel className="px-2.5 pt-3 pb-1 text-[13px] text-neutral-400" {...props} />
  );
}
export function CommandItem(props: Omit<ComponentProps<typeof Autocomplete.Item>, "className">) {
  return (
    <Autocomplete.Item
      className="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-sm text-neutral-600 outline-none data-highlighted:bg-neutral-100 data-highlighted:text-neutral-900 data-disabled:cursor-not-allowed data-disabled:opacity-40 [&_svg]:shrink-0"
      {...props}
    />
  );
}
