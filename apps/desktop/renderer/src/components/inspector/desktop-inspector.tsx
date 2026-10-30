import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
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
    minimumWidth: constraint?.content === content ? constraint.width + 5 : 0,
  });
  return (
    <aside
      ref={resize.ref}
      id="desktop-inspector"
      aria-label={t("inspector:desktopInspector.rightSidebar")}
      aria-hidden={!open}
      inert={!open}
      style={{ width: open ? resize.width : 0 }}
      className="relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-[#e9e9e9]"
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
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none focus-visible:border-l focus-visible:border-sky-500 focus-visible:outline-none"
          onPointerDown={resize.onPointerDown}
          onPointerMove={resize.onPointerMove}
          onPointerUp={resize.onPointerUp}
          onPointerCancel={resize.onPointerCancel}
          onLostPointerCapture={resize.onLostPointerCapture}
          onKeyDown={resize.onKeyDown}
        />
      )}
      <div className="mr-[3.5px] mb-[3.5px] flex min-h-0 min-w-0 flex-1 flex-col rounded-r-[14px] border-l border-neutral-200/70 bg-[#f8f8f8]">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MinimumWidthContext.Provider value={registerMinimum}>
            {children}
          </MinimumWidthContext.Provider>
        </div>
      </div>
    </aside>
  );
}
