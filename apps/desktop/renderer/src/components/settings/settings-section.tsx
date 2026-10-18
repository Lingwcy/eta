import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <h3 className="mb-2.5 text-sm font-medium text-neutral-800">{title}</h3>
      <Card>{children}</Card>
    </section>
  );
}
export function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 py-2.5 min-[901px]:flex-nowrap">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-neutral-800">{title}</p>
        {description && <p className="mt-0.5 text-xs/4 text-neutral-500">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}
