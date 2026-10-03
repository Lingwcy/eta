import { Field as BaseField } from "@base-ui/react/field";
import type { ReactNode } from "react";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <BaseField.Root className="flex flex-col gap-2 text-sm text-neutral-700">
      <BaseField.Label>{label}</BaseField.Label>
      {children}
    </BaseField.Root>
  );
}
