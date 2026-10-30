import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

function readWidth(storageKey: string) {
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved > 0) return saved;
  } catch {
    /* Resizing must work without storage. */
  }
  return undefined;
}
function saveWidth(storageKey: string, width: number) {
  try {
    localStorage.setItem(storageKey, String(width));
  } catch {
    /* A preference cannot block input. */
  }
}
function widthBounds(available: number) {
  const max = Math.max(0, Math.floor(available - Math.min(420, available * 0.7)));
  return { min: Math.min(220, max), max };
}
function clamp(width: number, bounds: { min: number; max: number }) {
  return Math.min(bounds.max, Math.max(bounds.min, width));
}
interface Owner {
  storageKey: string;
  defaultWidth: number;
}
interface Drag {
  owner: Owner;
  pointerId: number;
  target: HTMLDivElement;
  startX: number;
  startWidth: number;
  preference: number | undefined;
  next: number;
  changed: boolean;
  userSelect: string;
  cursor: string;
  onBlur: () => void;
}

/** Persist only completed gestures, separately from defaults and temporary viewport clamps. */
export function useInspectorWidth<T extends HTMLElement = HTMLElement>(
  open: boolean,
  {
    defaultWidth = 320,
    storageKey = "eta.inspector-width.v1",
    bounds: boundsFor = widthBounds,
    minimumWidth = 0,
  }: {
    defaultWidth?: number;
    storageKey?: string;
    bounds?: typeof widthBounds;
    minimumWidth?: number;
  } = {},
) {
  const ref = useRef<T>(null);
  const owner = useMemo(() => ({ storageKey, defaultWidth }), [storageKey, defaultWidth]);
  const admitted = useRef(owner);
  admitted.current = owner;
  const [preferences, setPreferences] = useState(
    () => new Map([[storageKey, readWidth(storageKey)]]),
  );
  const preferred = preferences.has(storageKey)
    ? preferences.get(storageKey)
    : readWidth(storageKey);
  const preference = useRef(preferred);
  preference.current = preferred;
  const measureBounds = (available: number) => {
    const next = boundsFor(available);
    return { min: Math.min(next.max, Math.max(next.min, minimumWidth)), max: next.max };
  };
  const [available, setAvailable] = useState(window.innerWidth);
  const bounds = measureBounds(available);
  const limits = useRef(bounds);
  limits.current = bounds;
  const [draggingOwner, setDraggingOwner] = useState<Owner>();
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const width = clamp(preferred ?? defaultWidth, bounds);
  const update = (next: number | undefined, target = owner) => {
    if (admitted.current === target) preference.current = next;
    setPreferences((previous) => new Map(previous).set(target.storageKey, next));
  };
  const finish = (commit: boolean, mounted = true) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    const accept = commit && current.changed && current.owner === admitted.current;
    const next = accept ? current.next : current.preference;
    if (current.owner === admitted.current) preference.current = next;
    if (mounted) {
      update(next, current.owner);
      setDraggingOwner(undefined);
    }
    if (accept) saveWidth(current.owner.storageKey, current.next);
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
    let previousAnchor: number | undefined;
    const measure = () => {
      const rect = parent?.getBoundingClientRect();
      const available = rect?.width || window.innerWidth;
      const anchor = rect?.right ?? available;
      const geometryChanged = previousAnchor !== undefined && previousAnchor !== anchor;
      previousAnchor = anchor;
      setAvailable(available);
      // Width policy and left-edge changes do not move this right-anchored drag baseline.
      if (geometryChanged) finishRef.current(false);
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
    finishRef.current(false);
    setPreferences((previous) =>
      previous.has(owner.storageKey)
        ? previous
        : new Map(previous).set(owner.storageKey, readWidth(owner.storageKey)),
    );
  }, [owner, open]);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!open || drag.current || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const onBlur = () => finishRef.current(false);
    const startWidth = clamp(preference.current ?? owner.defaultWidth, limits.current);
    drag.current = {
      owner,
      pointerId: event.pointerId,
      target: event.currentTarget,
      startX: event.clientX,
      startWidth,
      preference: preference.current,
      next: startWidth,
      changed: false,
      userSelect: document.body.style.userSelect,
      cursor: document.body.style.cursor,
      onBlur,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("blur", onBlur);
    setDraggingOwner(owner);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.owner !== admitted.current)
      return;
    current.next = clamp(current.startWidth + current.startX - event.clientX, limits.current);
    current.changed ||= current.next !== current.startWidth;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (drag.current === current && current.owner === admitted.current)
        update(current.next, current.owner);
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
    const current = clamp(preference.current ?? defaultWidth, limits.current);
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
    saveWidth(storageKey, result);
  };
  return {
    ref,
    width,
    preferredWidth: preferred ?? defaultWidth,
    min: bounds.min,
    max: bounds.max,
    dragging: draggingOwner === owner,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture: onPointerCancel,
    onKeyDown,
  };
}
