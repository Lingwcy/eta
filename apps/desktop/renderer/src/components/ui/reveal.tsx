import type { ReactNode } from "react";

/** A brief entrance transition; text updates do not replay it or keep repainting at rest. */
export function Reveal({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 transition-[opacity,transform] duration-200 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:transform-none motion-reduce:transition-none">
      {children}
    </div>
  );
}
