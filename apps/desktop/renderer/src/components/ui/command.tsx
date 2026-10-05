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
  variant?: "default" | "search" | "menu-search";
}) {
  return (
    <div className="relative w-full shrink-0">
      {variant !== "default" && (
        <Search
          size={variant === "menu-search" ? 14 : 15}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 text-neutral-400",
            variant === "menu-search" ? "left-2 stroke-[1.7]" : "left-3",
          )}
        />
      )}
      <Autocomplete.Input
        className={cn(
          "w-full border-0 bg-transparent px-4 pt-4 pb-3 text-[15px] text-neutral-800 outline-none placeholder:text-neutral-400",
          variant === "search" && "h-11 py-0 pl-9 text-sm",
          variant === "menu-search" && "h-7 px-2 py-0 pl-7 text-xs",
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
  size?: "default" | "compact" | "menu";
}) {
  return (
    <ScrollAreaRoot className="min-h-0 flex-1">
      <ScrollAreaViewport
        tabIndex={-1}
        className={
          size === "menu"
            ? "h-auto max-h-[min(240px,calc(var(--available-height)-80px))]"
            : size === "compact"
              ? "h-auto max-h-[min(280px,calc(var(--available-height)-100px))]"
              : "h-auto max-h-[calc(80dvh-64px)]"
        }
        render={<Autocomplete.List {...props} role="listbox" />}
      >
        <ScrollAreaContent className={size === "menu" ? "pr-0" : "pb-3 pl-1.5"}>
          {children}
        </ScrollAreaContent>
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
export function CommandItem({
  variant = "default",
  ...props
}: Omit<ComponentProps<typeof Autocomplete.Item>, "className"> & {
  variant?: "default" | "menu";
}) {
  return (
    <Autocomplete.Item
      className={cn(
        "flex items-center outline-none data-disabled:cursor-not-allowed [&_svg]:shrink-0",
        variant === "menu"
          ? "h-[26px] cursor-default gap-1.5 rounded-[5px] px-2 text-xs text-neutral-800 data-highlighted:bg-[#007aff] data-highlighted:text-white data-disabled:opacity-35 [&_svg]:size-3.5 [&_svg]:stroke-[1.7]"
          : "cursor-pointer gap-2 rounded-xl px-2.5 py-2 text-sm text-neutral-600 data-highlighted:bg-neutral-100 data-highlighted:text-neutral-900 data-disabled:opacity-40",
      )}
      {...props}
    />
  );
}
