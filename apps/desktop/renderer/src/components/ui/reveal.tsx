import { createContext, useContext, type ReactNode } from "react";

export const EntranceAnimation = createContext(true);

/** A brief entrance transition; text updates do not replay it or keep repainting at rest. */
export function Reveal({ children }: { children: ReactNode }) {
  const animate = useContext(EntranceAnimation);
  return (
    <div
      className={
        animate
          ? "min-w-0 transition-[opacity,translate] duration-(--eta-duration-panel) ease-(--eta-ease-out) motion-safe:starting:translate-y-1.5 starting:opacity-0 motion-reduce:duration-(--eta-duration-fast)"
          : "min-w-0"
      }
    >
      {children}
    </div>
  );
}
