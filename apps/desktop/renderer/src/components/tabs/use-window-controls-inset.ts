import { useLayoutEffect, useState } from "react";

type OverlayNavigator = Navigator & {
  windowControlsOverlay?: EventTarget & {
    readonly visible: boolean;
    getTitlebarAreaRect(): DOMRect;
  };
};

// Use native geometry rather than assuming a fixed caption-button width or DPI.
export function useWindowControlsInset() {
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    const overlay = (navigator as OverlayNavigator).windowControlsOverlay;
    if (!overlay) return;
    const update = () => {
      if (!overlay.visible) {
        setInset(0);
        return;
      }
      const { x, width } = overlay.getTitlebarAreaRect();
      setInset(Math.max(0, window.innerWidth - x - width));
    };
    update();
    overlay.addEventListener("geometrychange", update);
    window.addEventListener("resize", update);
    return () => {
      overlay.removeEventListener("geometrychange", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return inset;
}
