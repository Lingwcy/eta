import type { ReactNode } from "react";

export function SettingsPage({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div
      className={`mx-auto w-full max-w-[790px] px-6 min-[901px]:px-8 ${title ? "pt-8 pb-14 min-[901px]:pt-14" : "py-8"}`}
    >
      {title && (
        <h2 className="text-[22px] font-semibold tracking-tight text-neutral-800">{title}</h2>
      )}
      <div className={title ? "mt-8" : undefined}>{children}</div>
    </div>
  );
}
