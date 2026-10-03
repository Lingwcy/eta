import { useEffect, useRef } from "react";

/** Runs a text highlight only while active, without scheduling React updates. */
export function Shimmer({ children, active = true }: { children: string; active?: boolean }) {
  const highlight = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = highlight.current;
    if (!active || !element) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    const update = () => {
      animation?.cancel();
      animation = preference.matches
        ? undefined
        : element.animate([{ backgroundPosition: "200% 0" }, { backgroundPosition: "-200% 0" }], {
            duration: 2400,
            iterations: Infinity,
            easing: "linear",
          });
    };
    update();
    preference.addEventListener("change", update);
    return () => {
      animation?.cancel();
      preference.removeEventListener("change", update);
    };
  }, [active]);
  return (
    <span className="relative inline-grid max-w-full align-bottom">
      <span className="col-start-1 row-start-1 truncate">{children}</span>
      {active && (
        <span
          ref={highlight}
          aria-hidden="true"
          className="pointer-events-none col-start-1 row-start-1 truncate bg-linear-to-r from-transparent via-neutral-900/70 to-transparent bg-clip-text text-transparent [background-size:200%_100%] motion-reduce:hidden dark:via-white/80"
        >
          {children}
        </span>
      )}
    </span>
  );
}
