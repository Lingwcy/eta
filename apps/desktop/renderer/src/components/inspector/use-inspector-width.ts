import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

const STORAGE_KEY = "eta.inspector-width.v1";
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 220;
const MAIN_WIDTH = 420;

function readWidth() {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) return saved;
  } catch {
    // Layout remains usable when browser storage is unavailable.
  }
  return DEFAULT_WIDTH;
}

function saveWidth(width: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // A layout preference must not make resizing fail.
  }
}

function widthBounds(available: number) {
  // Keep the main region usable even below the desktop's normal minimum window width.
  const max = Math.max(0, Math.floor(available - Math.min(MAIN_WIDTH, available * 0.7)));
  return { min: Math.min(MIN_WIDTH, max), max };
}

function clamp(width: number, bounds: { min: number; max: number }) {
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

interface Drag {
  pointerId: number;
  target: HTMLDivElement;
  startX: number;
  startWidth: number;
  preference: number;
  next: number;
  changed: boolean;
  userSelect: string;
  cursor: string;
  onBlur: () => void;
}

/** Keep the saved preference independent of viewport clamping, and commit only completed gestures. */
export function useInspectorWidth(open: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [preferred, setPreferred] = useState(readWidth);
  const preference = useRef(preferred);
  const [bounds, setBounds] = useState(() => widthBounds(window.innerWidth));
  const limits = useRef(bounds);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const width = clamp(preferred, bounds);

  const update = (next: number) => {
    preference.current = next;
    setPreferred(next);
  };

  const finish = (commit: boolean, mounted = true) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    const next = commit && current.changed ? current.next : current.preference;
    preference.current = next;
    if (mounted) {
      setPreferred(next);
      setDragging(false);
    }
    if (commit && current.changed) saveWidth(next);
    if (document.body.style.userSelect === "none")
      document.body.style.userSelect = current.userSelect;
    if (document.body.style.cursor === "col-resize") document.body.style.cursor = current.cursor;
    window.removeEventListener("blur", current.onBlur);
    if (current.target.hasPointerCapture(current.pointerId))
      current.target.releasePointerCapture(current.pointerId);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    const parent = ref.current?.parentElement;
    const measure = () => {
      const next = widthBounds(parent?.getBoundingClientRect().width || window.innerWidth);
      const changed = limits.current.min !== next.min || limits.current.max !== next.max;
      limits.current = next;
      setBounds((previous) =>
        previous.min === next.min && previous.max === next.max ? previous : next,
      );
      // Geometry changes invalidate the pointer's original layout baseline.
      if (changed) finishRef.current(false);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (parent) observer?.observe(parent);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      finishRef.current(false, false);
    };
  }, []);

  useEffect(() => {
    if (!open) finishRef.current(false);
  }, [open]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!open || drag.current || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const onBlur = () => finishRef.current(false);
    drag.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      startX: event.clientX,
      startWidth: clamp(preference.current, limits.current),
      preference: preference.current,
      next: clamp(preference.current, limits.current),
      changed: false,
      userSelect: document.body.style.userSelect,
      cursor: document.body.style.cursor,
      onBlur,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("blur", onBlur);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.next = clamp(current.startWidth + current.startX - event.clientX, limits.current);
    current.changed ||= current.next !== current.startWidth;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (drag.current === current) update(current.next);
    });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.next = clamp(current.startWidth + current.startX - event.clientX, limits.current);
    current.changed ||= current.next !== current.startWidth;
    finish(true);
  };
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) finish(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open || drag.current) return;
    const current = clamp(preference.current, limits.current);
    const next =
      event.key === "ArrowLeft"
        ? current + 16
        : event.key === "ArrowRight"
          ? current - 16
          : event.key === "Home"
            ? limits.current.min
            : event.key === "End"
              ? limits.current.max
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const result = clamp(next, limits.current);
    update(result);
    saveWidth(result);
  };

  return {
    ref,
    width,
    min: bounds.min,
    max: bounds.max,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture: onPointerCancel,
    onKeyDown,
  };
}
