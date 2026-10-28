// @vitest-environment jsdom
import { expect, test, vi } from "vite-plus/test";
import { computerOverlayDocument } from "./overlay-document.ts";
import type { ComputerOverlayState } from "./overlay.ts";

test("the floating view preserves its image during pointer updates, maps letterboxed negative desktop coordinates and stops its own admission", () => {
  let receive!: (state: ComputerOverlayState) => void;
  const stopped: string[] = [];
  vi.useFakeTimers();
  const html = computerOverlayDocument("preview");
  document.documentElement.innerHTML = html;
  Object.defineProperty(window, "etaComputerOverlay", {
    configurable: true,
    value: {
      subscribe: (listener: typeof receive) => {
        receive = listener;
      },
      stop: (id: string) => stopped.push(id),
    },
  });
  const script = document.querySelector("script")!.textContent!;
  // oxlint-disable-next-line typescript/no-implied-eval -- Exercise our trusted static renderer against the fixture DOM.
  new Function("window", "document", "ResizeObserver", script)(
    window,
    document,
    class {
      observe() {}
    },
  );
  try {
    const viewport = document.querySelector<HTMLElement>("#viewport")!,
      image = document.querySelector<HTMLImageElement>("#image")!;
    viewport.getBoundingClientRect = () => ({ width: 360, height: 210 }) as DOMRect;
    Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 400 } });
    const state: ComputerOverlayState = {
      id: "owner",
      title: '<img src=x onerror="bad()">',
      waiting: "Loading",
      stopLabel: "Stop",
      imageVersion: 1,
      pointerSequence: 1,
      image: { type: "image", mimeType: "image/png", data: "test" },
      bounds: { x: -300, y: 40, width: 600, height: 400 },
      pointer: {
        snapshot: "one",
        windowId: 42,
        point: { x: -200, y: 60 },
        bounds: { x: -300, y: 40, width: 600, height: 400 },
        phase: "up",
        visible: true,
      },
    };
    receive(state);
    const source = image.getAttribute("src");
    receive({ ...state, image: undefined, pointerSequence: 2 });
    expect(image.getAttribute("src")).toBe(source);
    expect(document.querySelector<HTMLElement>("#agent")!.style.left).toBe("75px");
    expect(document.querySelector<HTMLElement>("#agent")!.style.top).toBe("10.5px");
    expect(document.querySelector("#title")!.textContent).toBe(state.title);
    expect(document.querySelectorAll("#title img")).toHaveLength(0);
    document.querySelector<HTMLButtonElement>("#stop")!.click();
    expect(stopped).toEqual(["owner"]);
  } finally {
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "etaComputerOverlay");
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
