import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useInspectorWidth } from "./use-inspector-width";
import type { InspectorContent } from "./inspector-tabs";

const defaults = { diff: 800, github: 360, subagents: 320 } as const;

const MinimumWidthContext = createContext<((width: number) => () => void) | null>(null);

export function useInspectorMinimumWidth(width: number) {
  const register = useContext(MinimumWidthContext);
  useEffect(() => register?.(width), [register, width]);
}

/** A desktop-wide content slot; opening it shares layout space with every main tab. */
export function DesktopInspector({
  open,
  children,
  content = "subagents",
  defaultWidth = defaults[content],
}: {
  open: boolean;
  children: ReactNode;
  defaultWidth?: number;
  content?: InspectorContent;
}) {
  useTranslation();
  const [constraint, setConstraint] = useState<{
    owner: object;
    content: InspectorContent;
    width: number;
  }>();
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevContent, setPrevContent] = useState(content);
  const [animatingOpen, setAnimatingOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setAnimatingOpen(true);
  } else if (content !== prevContent) {
    setPrevContent(content);
    setAnimatingOpen(false);
  }
  const registerMinimum = useCallback(
    (width: number) => {
      const owner = {};
      setConstraint({ owner, content, width });
      return () => setConstraint((current) => (current?.owner === owner ? undefined : current));
    },
    [content],
  );
  const resize = useInspectorWidth(open, {
    defaultWidth,
    storageKey: `eta.inspector-width.${content}.v1`,
    // Include the inspector’s border and outer margin, not just its content slot.
    minimumWidth: constraint?.content === content ? constraint.width + 4.5 : 0,
  });
  useEffect(() => {
    if (resize.dragging) setAnimatingOpen(false);
  }, [resize.dragging]);
  useEffect(() => {
    if (!animatingOpen) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      setAnimatingOpen(false);
      return;
    }
    const timer = window.setTimeout(() => setAnimatingOpen(false), 240);
    return () => window.clearTimeout(timer);
  }, [animatingOpen]);
  return (
    <aside
      ref={resize.ref}
      id="desktop-inspector"
      aria-label={t("inspector:desktopInspector.rightSidebar")}
      aria-hidden={!open}
      inert={!open}
      style={{ width: open ? resize.width : 0 }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "width") {
          setAnimatingOpen(false);
        }
      }}
      onTransitionCancel={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "width") {
          setAnimatingOpen(false);
        }
      }}
      className={cn(
        "relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-shell",
        animatingOpen &&
          "transition-[width] duration-(--eta-duration-panel) ease-(--eta-ease-out) motion-reduce:transition-none",
      )}
    >
      {open && (
        <div
          role="separator"
          tabIndex={0}
          aria-label={t("inspector:desktopInspector.resizeSidebar")}
          aria-orientation="vertical"
          aria-controls="desktop-inspector"
          aria-valuemin={resize.min}
          aria-valuemax={resize.max}
          aria-valuenow={resize.width}
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none focus-visible:border-l focus-visible:border-sky-border-500 focus-visible:outline-none"
          onPointerDown={(event) => {
            setAnimatingOpen(false);
            resize.onPointerDown(event);
          }}
          onPointerMove={resize.onPointerMove}
          onPointerUp={resize.onPointerUp}
          onPointerCancel={resize.onPointerCancel}
          onLostPointerCapture={resize.onLostPointerCapture}
          onKeyDown={(event) => {
            setAnimatingOpen(false);
            resize.onKeyDown(event);
          }}
        />
      )}
      <div
        className={cn(
          "mr-[3.5px] mb-[3.5px] flex min-h-0 min-w-0 flex-1 flex-col rounded-r-[14px] border-l border-border/70 bg-panel transition-[opacity,translate] duration-(--eta-duration-panel) ease-(--eta-ease-out) motion-reduce:duration-(--eta-duration-fast)",
          open ? "translate-x-0 opacity-100" : "motion-safe:translate-x-2 opacity-0",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MinimumWidthContext.Provider value={registerMinimum}>
            {children}
          </MinimumWidthContext.Provider>
        </div>
      </div>
    </aside>
  );
}
