import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const alertVariants = cva("rounded-xl border px-4 py-3 text-sm", {
  variants: {
    tone: {
      error: "border-red-200 bg-red-50 text-red-700",
      warning: "border-amber-200 bg-amber-50 text-amber-900",
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
