import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Reveal an overflowing name once per hover, then return to its ellipsis. */
export function SlidingLabel({ text }: { text: string }) {
  const label = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  return (
    <span
      className="min-w-0 flex-1 overflow-hidden text-left"
      onPointerEnter={(event) => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        setDistance(Math.max(0, label.current!.scrollWidth - event.currentTarget.clientWidth));
      }}
      onPointerLeave={() => setDistance(0)}
    >
      <span
        ref={label}
        className={cn(
          "block transition-transform ease-linear motion-reduce:transition-none",
          distance ? "w-max whitespace-nowrap" : "truncate",
        )}
        style={{
          transform: `translateX(-${distance}px)`,
          transitionDuration: distance ? `${Math.max(1.5, distance / 40)}s` : "150ms",
          transitionDelay: distance ? "350ms" : "0ms",
        }}
      >
        {text}
      </span>
    </span>
  );
}
