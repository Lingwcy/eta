import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import "./agent-thinking.css";
import { cn } from "@/lib/utils";
import type { AgentThinkingVariant } from "../../../../src/appearance.ts";

export type { AgentThinkingVariant } from "../../../../src/appearance.ts";

export type AgentThinkingTone = "subtle" | "default" | "primary" | "accent";

export interface AgentThinkingProps {
  variant?: AgentThinkingVariant;
  /** Status label, e.g. "Thinking" or "Searching the docs". */
  label?: string;
  /** Tone of the indicator + label. Defaults per variant (`stars` is subtle). */
  tone?: AgentThinkingTone;
  /** Animated highlight traveling across the label. */
  shimmer?: boolean;
  /** Elapsed seconds since mount, rendered after the label. */
  showTimer?: boolean;
  className?: string;
  /** Observed phase start; changing the visual variant preserves elapsed time. */
  startedAt?: number;
  waiting?: boolean;
  active?: boolean;
}

const TONE_COLORS: Record<AgentThinkingTone, string> = {
  subtle: "var(--color-neutral-400)",
  default: "var(--color-neutral-500)",
  primary: "var(--color-neutral-800)",
  accent: "var(--color-blue-500)",
};

const VARIANT_TONE: Record<AgentThinkingVariant, AgentThinkingTone> = {
  wave: "default",
  spin: "default",
  stars: "subtle",
  infinity: "default",
};

/* ------------------------------------------------------------------- dots */

const DOTS_GRID = 3;
const DOTS_SIZE = 4;
const DOTS_GAP = 2;
const DOTS_TICK_MS = 80;
const DOTS_FADE_MS = 220;
const DOTS_TRAIL = 0.3;
const DOTS_MIN_OPACITY = 0.12;
const DOTS_PHASE_STEP = 1 / 8;

// Static first frame: identical on server and client, and the resting state
// under prefers-reduced-motion.
const DOTS_SEED = [0.55, 0.3, 0.15, 0.85, 0.55, 0.3, 1, 0.85, 0.55];

/**
 * How far along the pattern's travel direction each cell sits, in [0, 1).
 * The wave scalar is compressed below 1 so the phase wrap reads as the front
 * leaving the grid and re-entering; the spin angle is naturally cyclic.
 */
function dotScalar(variant: "wave" | "spin", col: number, row: number) {
  const m = DOTS_GRID - 1;
  if (variant === "wave") {
    return ((col + row) / (2 * m)) * (DOTS_GRID / (DOTS_GRID + 1));
  }
  const center = m / 2;
  return (Math.atan2(row - center, col - center) / (2 * Math.PI) + 1) % 1;
}

function dotOpacities(variant: "wave" | "spin", phase: number) {
  return Array.from({ length: DOTS_GRID * DOTS_GRID }, (_, i) => {
    const s = dotScalar(variant, i % DOTS_GRID, Math.floor(i / DOTS_GRID));
    // Comet: bright head at the phase front, tail fading behind it.
    const behind = (phase - s + 1) % 1;
    const lit = Math.max(0, 1 - behind / DOTS_TRAIL) ** 1.5;
    return DOTS_MIN_OPACITY + (1 - DOTS_MIN_OPACITY) * lit;
  });
}

function DotsIndicator({ variant, animated }: { variant: "wave" | "spin"; animated: boolean }) {
  const [opacities, setOpacities] = useState<number[]>(DOTS_SEED);

  useEffect(() => {
    if (!animated) return;
    let phase = 0;
    const id = window.setInterval(() => {
      phase = (phase + DOTS_PHASE_STEP) % 1;
      setOpacities(dotOpacities(variant, phase));
    }, DOTS_TICK_MS);
    return () => window.clearInterval(id);
  }, [variant, animated]);

  return (
    <span
      aria-hidden
      className="grid shrink-0"
      style={{
        gridTemplateColumns: `repeat(${DOTS_GRID}, ${DOTS_SIZE}px)`,
        gap: DOTS_GAP,
      }}
    >
      {opacities.map((opacity, i) => (
        <span
          key={i}
          className="rounded-[1px] bg-current"
          style={{
            width: DOTS_SIZE,
            height: DOTS_SIZE,
            opacity: animated ? opacity : DOTS_SEED[i],
            transition: animated ? `opacity ${DOTS_FADE_MS}ms ease` : undefined,
          }}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ stars */

const STAR_PERIOD_S = 1.4;
const STAR_SIZE = 14;
const STAR_COUNT = 5;
const STAR_LAYOUT = [
  { x: 50, y: 46, scale: 1 },
  { x: 18, y: 22, scale: 0.55 },
  { x: 82, y: 26, scale: 0.45 },
  { x: 78, y: 76, scale: 0.55 },
  { x: 22, y: 78, scale: 0.4 },
];
const STAR_PATH = "M12 0C13 7 17 11 24 12C17 13 13 17 12 24C11 17 7 13 0 12C7 11 11 7 12 0Z";

function StarsIndicator() {
  const box = STAR_SIZE * 1.5;
  return (
    <span
      aria-hidden
      className="eta-agent-thinking-stars relative block shrink-0"
      style={{ width: box, height: box }}
    >
      {STAR_LAYOUT.slice(0, STAR_COUNT).map((star, i) => {
        const size = STAR_SIZE * star.scale;
        return (
          <svg
            key={i}
            viewBox="0 0 24 24"
            className="eta-agent-thinking-star absolute"
            style={{
              width: size,
              height: size,
              left: `${star.x}%`,
              top: `${star.y}%`,
              marginLeft: -size / 2,
              marginTop: -size / 2,
              animationDuration: `${STAR_PERIOD_S}s`,
              animationDelay: `${(i * STAR_PERIOD_S * 0.7) / STAR_COUNT}s`,
            }}
          >
            <path d={STAR_PATH} fill="currentColor" />
          </svg>
        );
      })}
    </span>
  );
}

/* --------------------------------------------------------------- infinity */

const INFINITY_WIDTH = 32;
const INFINITY_TRAIL = 11;
const INFINITY_STROKE = 2.75;
const INFINITY_DURATION_S = 1.2;
const INFINITY_PATH = "M28 14C33 5 47 5 47 14C47 23 33 23 28 14C23 5 9 5 9 14C9 23 23 23 28 14Z";

function InfinityIndicator() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 56 28"
      className="shrink-0"
      // The figure-eight spans x 9-47 of the 56-wide viewBox, so the svg box
      // carries ~4px of dead space per side at this width; pull it back in so
      // the label sits at the loader's real gap.
      style={{ width: INFINITY_WIDTH, height: INFINITY_WIDTH / 2, margin: "0 -4px" }}
    >
      <path
        d={INFINITY_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={INFINITY_STROKE}
        opacity={0.15}
      />
      <path
        d={INFINITY_PATH}
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={INFINITY_STROKE}
        strokeLinecap="round"
        strokeDasharray={`${INFINITY_TRAIL} ${100 - INFINITY_TRAIL}`}
        className="eta-agent-thinking-comet"
        style={{ animationDuration: `${INFINITY_DURATION_S}s` }}
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ timer */

function ThinkingLabel({
  label,
  waiting,
  shimmer,
  showTimer,
  startedAt,
  active,
}: {
  label: string;
  waiting: boolean;
  shimmer: boolean;
  showTimer: boolean;
  startedAt?: number;
  active: boolean;
}) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || (!showTimer && !waiting)) return;
    const update = () => setNow(Date.now());
    update();
    const id = window.setInterval(update, 100);
    return () => window.clearInterval(id);
  }, [startedAt, active, showTimer, waiting]);

  const elapsed = Math.max(0, (now - (startedAt ?? mountedAt)) / 1000);
  return (
    <>
      <span className={cn("text-sm font-medium", shimmer && "eta-agent-thinking-label")}>
        {waiting && elapsed >= 30 ? `${label}（耗时较长）` : label}
      </span>
      {showTimer && (
        <span aria-hidden className="font-mono text-xs text-neutral-400 tabular-nums">
          {elapsed.toFixed(1)}s
        </span>
      )}
    </>
  );
}

/** Stop background work in hidden tabs and respond to motion preference changes. */
function useThinkingActivity(active: boolean) {
  const [visible, setVisible] = useState(() => !document.hidden);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateVisibility = () => setVisible(!document.hidden);
    const updateMotion = () => setReducedMotion(motion.matches);
    document.addEventListener("visibilitychange", updateVisibility);
    motion.addEventListener("change", updateMotion);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      motion.removeEventListener("change", updateMotion);
    };
  }, []);
  return { ticking: active && visible, animated: active && visible && !reducedMotion };
}

/* ----------------------------------------------------------------- loader */

export function AgentThinking({
  variant = "wave",
  label = "正在思考",
  tone,
  shimmer = true,
  showTimer = true,
  className,
  startedAt,
  waiting = false,
  active = true,
}: AgentThinkingProps) {
  const { animated, ticking } = useThinkingActivity(active);
  const color = TONE_COLORS[tone ?? VARIANT_TONE[variant]];

  return (
    <div
      role="status"
      data-animated={animated}
      className={cn("eta-agent-thinking flex items-center gap-2.5", className)}
      style={{ color, "--eta-agent-thinking-tone": color } as CSSProperties}
    >
      {(variant === "wave" || variant === "spin") && (
        <DotsIndicator variant={variant} animated={animated} />
      )}
      {variant === "stars" && <StarsIndicator />}
      {variant === "infinity" && <InfinityIndicator />}
      <ThinkingLabel
        label={label}
        waiting={waiting}
        shimmer={shimmer}
        showTimer={showTimer}
        startedAt={startedAt}
        active={ticking}
      />
    </div>
  );
}
