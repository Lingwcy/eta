// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { useWindowControlsInset } from "./use-window-controls-inset";

class Overlay extends EventTarget {
  visible = true;
  rect = new DOMRect(0, 0, 962, 42);
  getTitlebarAreaRect = vi.fn(() => this.rect);
  change(visible: boolean, rect: DOMRect) {
    this.visible = visible;
    this.rect = rect;
    this.dispatchEvent(new Event("geometrychange"));
  }
}

let root: Root | undefined;
let host: HTMLDivElement;

function Probe() {
  return createElement("output", null, useWindowControlsInset());
}

async function mount(overlay?: Overlay) {
  vi.stubGlobal("navigator", { windowControlsOverlay: overlay });
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(Probe));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 1100);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

test("platforms without a window controls overlay need no extra inset", async () => {
  await mount();
  expect(host.textContent).toBe("0");
});

test("native geometry follows resize, DPI changes and fullscreen exit/re-entry", async () => {
  const overlay = new Overlay();
  await mount(overlay);
  expect(host.textContent).toBe("138");

  await act(async () => {
    vi.stubGlobal("innerWidth", 800);
    overlay.rect = new DOMRect(0, 0, 662, 42);
    window.dispatchEvent(new Event("resize"));
  });
  expect(host.textContent).toBe("138");

  await act(async () => overlay.change(true, new DOMRect(0, 0, 634, 42)));
  expect(host.textContent).toBe("166");

  // Hidden overlays report an empty rect; do not reserve the whole viewport in fullscreen.
  await act(async () => overlay.change(false, new DOMRect()));
  expect(host.textContent).toBe("0");
  await act(async () => overlay.change(true, new DOMRect(0, 0, 634, 42)));
  expect(host.textContent).toBe("166");
});

test("accounts for the native titlebar origin and never produces a negative inset", async () => {
  const overlay = new Overlay();
  overlay.rect = new DOMRect(10, 0, 952, 42);
  await mount(overlay);
  expect(host.textContent).toBe("138");
  await act(async () => overlay.change(true, new DOMRect(0, 0, 1101, 42)));
  expect(host.textContent).toBe("0");
});

test("releases native geometry and resize observation when the tab bar unmounts", async () => {
  const overlay = new Overlay();
  await mount(overlay);
  await act(async () => root?.unmount());
  root = undefined;
  overlay.getTitlebarAreaRect.mockClear();
  overlay.change(true, new DOMRect(0, 0, 900, 42));
  window.dispatchEvent(new Event("resize"));
  expect(overlay.getTitlebarAreaRect).not.toHaveBeenCalled();
});
