import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const alertVariants = cva("rounded-xl border px-4 py-3 text-sm break-words", {
  variants: {
    tone: {
      error: "border-danger-border-200 bg-danger-tint-50 text-danger-text-700",
      warning: "border-warning-border-200 bg-warning-tint-50 text-warning-text-900",
    },
  },
  defaultVariants: { tone: "error" },
});
export function Alert({
  tone,
  children,
}: VariantProps<typeof alertVariants> & { children: ReactNode }) {
  return (
    <div role={tone === "warning" ? "status" : "alert"} className={alertVariants({ tone })}>
      {children}
    </div>
  );
}
