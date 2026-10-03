import type { ReactNode } from "react";

export function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[790px] px-6 pt-10 pb-16 min-[901px]:px-8 min-[901px]:pt-[72px]">
      <h2 className="text-[26px] font-semibold tracking-tight text-neutral-800">{title}</h2>
      <div className="mt-12">{children}</div>
    </div>
  );
}
