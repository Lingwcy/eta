import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const skeletonVariants = cva("rounded-full bg-surface-hover/70", {
  variants: {
    size: {
      xs: "h-1.5",
      sm: "h-2.5",
      default: "h-3.5",
    },
    active: {
      true: "motion-safe:animate-[eta-breathe_1.6s_var(--eta-ease-in-out)_infinite]",
      false: "",
    },
  },
  defaultVariants: { size: "xs", active: true },
});

/** Opacity-only breathing placeholder bar for loading states. */
export function Skeleton({
  size,
  active = true,
  className,
}: VariantProps<typeof skeletonVariants> & { className?: string }) {
  return <div aria-hidden="true" className={cn(skeletonVariants({ size, active }), className)} />;
}
