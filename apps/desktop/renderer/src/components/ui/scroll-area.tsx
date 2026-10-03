import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type RootProps = Omit<ComponentProps<typeof BaseScrollArea.Root>, "className"> & {
  className?: string;
};
type ViewportProps = Omit<ComponentProps<typeof BaseScrollArea.Viewport>, "className"> & {
  className?: string;
};
type ContentProps = Omit<ComponentProps<typeof BaseScrollArea.Content>, "className"> & {
  className?: string;
};

export function ScrollAreaRoot({ className, ...props }: RootProps) {
  return (
    <BaseScrollArea.Root
      className={cn("relative min-h-0 min-w-0 overflow-hidden", className)}
      {...props}
    />
  );
}
export function ScrollAreaViewport({ className, ...props }: ViewportProps) {
  return (
    <BaseScrollArea.Viewport
      className={cn(
        "h-full w-full overscroll-contain rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-300",
        className,
      )}
      {...props}
    />
  );
}
export function ScrollAreaContent({ className, ...props }: ContentProps) {
  return <BaseScrollArea.Content className={cn("min-w-0! w-full pr-3", className)} {...props} />;
}
export function ScrollAreaScrollbar() {
  return (
    <BaseScrollArea.Scrollbar
      orientation="vertical"
      className="absolute inset-y-1 right-0 flex w-2 touch-none justify-center px-0.5 opacity-0 transition-opacity duration-150 select-none data-scrolling:opacity-100 motion-reduce:transition-none"
    >
      <BaseScrollArea.Thumb className="w-full rounded-full bg-neutral-400/50 hover:bg-neutral-400/80" />
    </BaseScrollArea.Scrollbar>
  );
}

export function ScrollAreaFade({ edge }: { edge: "top" | "bottom" }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-8 from-white to-transparent",
        edge === "top" ? "top-0 bg-linear-to-b" : "bottom-0 bg-linear-to-t",
      )}
    />
  );
}

export function ScrollArea({ children, ...props }: RootProps) {
  return (
    <ScrollAreaRoot {...props}>
      <ScrollAreaViewport>
        <ScrollAreaContent>{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar />
    </ScrollAreaRoot>
  );
}
