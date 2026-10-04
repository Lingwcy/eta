import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-transparent text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-neutral-900 text-white hover:bg-neutral-700",
        secondary: "bg-neutral-100 text-neutral-700 hover:bg-neutral-200",
        outline: "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50",
        ghost: "text-neutral-700 hover:bg-neutral-200/50",
        "ghost-muted": "text-neutral-400 hover:bg-neutral-200/50 hover:text-neutral-700",
        "ghost-destructive": "text-red-600 hover:bg-red-50",
        accent: "text-[#ed714b] hover:bg-orange-50 hover:text-[#cf5530]",
        link: "text-neutral-500 underline-offset-4 hover:text-neutral-800 hover:underline",
        timeline: "group rounded-none text-neutral-300 hover:text-neutral-600",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 gap-1.5 px-2.5 text-xs",
        compact: "h-7 gap-1.5 px-2 text-xs",
        pill: "h-8 gap-1.5 rounded-full px-2.5 text-[13px] font-normal",
        row: "h-auto w-full justify-start px-2 py-1.5 text-left font-normal",
        "row-sm": "h-auto w-full justify-start px-2 py-1.5 text-left text-[13px] font-normal",
        "row-compact": "h-7 w-full justify-start px-2 text-left text-[13px] font-normal",
        icon: "size-9 rounded-xl",
        "icon-sm": "size-[30px] rounded-lg",
        "icon-xs": "size-7 rounded-md",
        "icon-round": "size-[30px] rounded-full",
        "icon-tiny": "size-5 rounded-full",
        tick: "h-2.5 w-7 min-h-0 shrink justify-start gap-0 border-0 p-0",
      },
      selected: { true: "bg-neutral-200/70 text-neutral-800", false: "" },
      indent: { true: "pl-8", false: "" },
    },
    defaultVariants: { variant: "default", size: "default", selected: false, indent: false },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;
type ButtonProps = Omit<ComponentProps<typeof BaseButton>, "className"> &
  VariantProps<typeof buttonVariants> & { className?: string };

export function Button({
  className,
  variant,
  size,
  selected,
  indent,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      type={type}
      data-slot="button"
      className={cn(buttonVariants({ variant, size, selected, indent }), className)}
      {...props}
    />
  );
}

export { buttonVariants, type ButtonProps, type ButtonSize, type ButtonVariant };
