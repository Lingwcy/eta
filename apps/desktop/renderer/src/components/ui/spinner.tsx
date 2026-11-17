import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const spinnerVariants = cva(
  "inline-block shrink-0 rounded-full border-border-strong border-t-subtle forced-colors:border-t-transparent",
  {
    variants: {
      size: {
        xs: "size-3 border-[1.5px]",
        sm: "size-3.5 border-2",
        default: "size-4 border-2",
      },
      active: {
        true: "animate-spin motion-reduce:[animation-duration:6s]",
        false: "",
      },
    },
    defaultVariants: { size: "sm", active: true },
  },
);

/** Lightweight GPU-composited spinner that pauses cleanly when inactive or under reduced motion. */
export function Spinner({
  size,
  active = true,
  className,
}: VariantProps<typeof spinnerVariants> & { className?: string }) {
  return <span aria-hidden="true" className={cn(spinnerVariants({ size, active }), className)} />;
}
