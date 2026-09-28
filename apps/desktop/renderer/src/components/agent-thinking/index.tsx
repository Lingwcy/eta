import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { LaneSnapshot } from "@eta/agent";
import { cn } from "@/lib/utils";

/**
 * Agent Thinking — 展示在输入框上方的实时思考状态组件。
 *
 * 提供 4 种动效变体：
 * - `wave`     对角波浪网格渐变
 * - `spin`     顺时针环绕旋转网格
 * - `stars`    星芒交错闪烁 Twinkling
 * - `infinity` 8 字彗星流星轨迹
 */

export type AgentThinkingVariant = "wave" | "spin" | "stars" | "infinity";
export type AgentThinkingTone = "subtle" | "default" | "primary" | "accent";

export interface AgentThinkingProps {
  variant?: AgentThinkingVariant;
  /** 状态文案，例如 "Thinking" 或 "Searching the docs" */
  label?: string;
  /** 指示器与文案的色调风格 */
  tone?: AgentThinkingTone;
  /** 是否开启文字流动光泽高亮（Shimmer） */
  shimmer?: boolean;
  /** 是否展示从挂载开始计时的耗时秒数 */
  showTimer?: boolean;
  startedAt?: NonNullable<LaneSnapshot["operation"]>["startedAt"];
  className?: string;
}

const TONE_COLORS: Record<AgentThinkingTone, string> = {
  subtle: "var(--color-text-tertiary, #a3a3a3)",
  default: "var(--color-text-secondary, #525252)",
  primary: "var(--color-text-primary, #171717)",
  accent: "var(--color-blue-500, #3b82f6)",
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

const DOTS_SEED = [0.55, 0.3, 0.15, 0.85, 0.55, 0.3, 1, 0.85, 0.55];

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
    const behind = (phase - s + 1) % 1;
    const lit = Math.max(0, 1 - behind / DOTS_TRAIL) ** 1.5;
    return DOTS_MIN_OPACITY + (1 - DOTS_MIN_OPACITY) * lit;
  });
}

function DotsIndicator({ variant }: { variant: "wave" | "spin" }) {
  const [opacities, setOpacities] = useState<number[]>(DOTS_SEED);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let phase = 0;
    let ticks = 0;
    const id = window.setInterval(() => {
      phase = (phase + DOTS_PHASE_STEP) % 1;
      setOpacities(dotOpacities(variant, phase));
      if (++ticks >= 16) window.clearInterval(id);
    }, DOTS_TICK_MS);
    return () => window.clearInterval(id);
  }, [variant]);

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
            opacity,
            transition: `opacity ${DOTS_FADE_MS}ms ease`,
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
      className="bui-agent-thinking-stars relative block shrink-0"
      style={{ width: box, height: box }}
    >
      {STAR_LAYOUT.slice(0, STAR_COUNT).map((star, i) => {
        const size = STAR_SIZE * star.scale;
        return (
          <svg
            key={i}
            viewBox="0 0 24 24"
            className="bui-agent-thinking-star absolute"
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
        className="bui-agent-thinking-comet"
        style={{ animationDuration: `${INFINITY_DURATION_S}s` }}
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ timer */

function ElapsedTimer({ startedAt }: { startedAt?: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = startedAt ?? Date.now();
    const update = () => setElapsed(Math.max(0, (Date.now() - started) / 1000));
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <span className="font-mono text-xs text-neutral-400 tabular-nums">{elapsed.toFixed(1)}s</span>
  );
}

/* ----------------------------------------------------------------- animations */

const INLINE_ANIMATIONS = `
@keyframes bui-star-twinkle {
  0%, 100% { opacity: 0.15; transform: scale(0.65); }
  50% { opacity: 1; transform: scale(1.15); }
}
.bui-agent-thinking-star {
  animation-name: bui-star-twinkle;
  animation-iteration-count: 1;
  animation-timing-function: ease-in-out;
}
@keyframes bui-comet-travel {
  from { stroke-dashoffset: 100; }
  to { stroke-dashoffset: 0; }
}
.bui-agent-thinking-comet {
  animation-name: bui-comet-travel;
  animation-iteration-count: 1;
  animation-timing-function: linear;
}
@keyframes bui-label-shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
.bui-agent-thinking-label {
  background: linear-gradient(
    90deg,
    currentColor 0%,
    rgba(255, 255, 255, 0.85) 50%,
    currentColor 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: bui-label-shimmer 2.4s 1 linear;
}
@media (prefers-reduced-motion: reduce) {
  .bui-agent-thinking-star,
  .bui-agent-thinking-comet,
  .bui-agent-thinking-label {
    animation: none !important;
  }
  .bui-agent-thinking-label {
    -webkit-text-fill-color: currentColor !important;
  }
}
`;

/* ----------------------------------------------------------------- loader */

export function AgentThinking({
  variant = "wave",
  label = "Thinking",
  tone,
  shimmer = true,
  showTimer = true,
  startedAt,
  className,
}: AgentThinkingProps) {
  const color = TONE_COLORS[tone ?? VARIANT_TONE[variant]];

  return (
    <div
      role="status"
      className={cn("flex items-center gap-2.5 select-none", className)}
      style={{ color, "--bui-agent-thinking-tone": color } as CSSProperties}
    >
      <style>{INLINE_ANIMATIONS}</style>
      {(variant === "wave" || variant === "spin") && <DotsIndicator variant={variant} />}
      {variant === "stars" && <StarsIndicator />}
      {variant === "infinity" && <InfinityIndicator />}
      <span
        aria-label={label}
        className={cn("text-sm font-medium", shimmer && "bui-agent-thinking-label")}
      >
        {label}
      </span>
      {showTimer && <ElapsedTimer startedAt={startedAt} />}
    </div>
  );
}
