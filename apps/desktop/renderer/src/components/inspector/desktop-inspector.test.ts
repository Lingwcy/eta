// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DesktopInspector } from "./desktop-inspector";

const STORAGE_KEY = "eta.inspector-width.v1";
let root: Root;
let host: HTMLDivElement;
let available: number;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const captured = new Set<number>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("innerWidth", 1200);
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  localStorage.clear();
  captured.clear();
  available = 1200;
  host = document.createElement("div");
  host.getBoundingClientRect = () => new DOMRect(0, 0, available, 800);
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  document.body.removeAttribute("style");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(open = true, children: ReactNode = createElement("div", null, "Content")) {
  await act(async () => root.render(createElement(DesktopInspector, { open, children })));
}

function sidebar() {
  return document.querySelector<HTMLElement>("#desktop-inspector")!;
}

function width() {
  return Number.parseFloat(sidebar().style.width);
}

function divider() {
  const element = document.querySelector<HTMLDivElement>('[role="separator"]')!;
  element.setPointerCapture = (id) => captured.add(id);
  element.hasPointerCapture = (id) => captured.has(id);
  element.releasePointerCapture = (id) => {
    captured.delete(id);
    element.dispatchEvent(pointer("lostpointercapture", 0, id));
  };
  return element;
}

function pointer(type: string, x: number, id = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: true } });
  return event;
}

async function dispatch(target: EventTarget, event: Event) {
  await act(async () => target.dispatchEvent(event));
}

async function flushFrame() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

async function key(element: HTMLElement, value: string) {
  await dispatch(
    element,
    new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
  );
}

test("captured divider drag resizes once per frame and saves only on release", async () => {
  await render();
  const separator = divider();
  const writes = vi.spyOn(Storage.prototype, "setItem");
  document.body.style.userSelect = "text";
  document.body.style.cursor = "crosshair";
  expect(width()).toBe(320);
  await dispatch(separator, pointer("pointerdown", 880));
  expect(captured.has(1)).toBe(true);
  expect(document.body.style.userSelect).toBe("none");
  expect(sidebar().className).not.toContain("transition-[width]");
  await dispatch(separator, pointer("pointermove", 760));
  await dispatch(separator, pointer("pointermove", 700));
  expect(frames.size).toBe(1);
  expect(width()).toBe(320);
  expect(writes).not.toHaveBeenCalled();
  await flushFrame();
  expect(width()).toBe(500);
  expect(writes).not.toHaveBeenCalled();
  await dispatch(separator, pointer("pointerup", 700));
  expect(captured.size).toBe(0);
  expect(document.body.style.userSelect).toBe("text");
  expect(document.body.style.cursor).toBe("crosshair");
  expect(writes).toHaveBeenCalledExactlyOnceWith(STORAGE_KEY, "500");
  expect(sidebar().className).toContain("transition-[width]");
  await render(false);
  expect(width()).toBe(0);
  expect(document.querySelector('[role="separator"]')).toBeNull();
  await render(true);
  expect(width()).toBe(500);
});

test("release flushes the latest pointer position before a scheduled frame", async () => {
  await render();
  const separator = divider();
  await dispatch(separator, pointer("pointerdown", 880));
  await dispatch(separator, pointer("pointermove", 800));
  await dispatch(separator, pointer("pointerup", 800));
  expect(width()).toBe(400);
  expect(frames.size).toBe(0);
  expect(localStorage.getItem(STORAGE_KEY)).toBe("400");
  await flushFrame();
  expect(width()).toBe(400);
});

test("pointerup captures its final position even without a final move event", async () => {
  await render();
  let separator = divider();
  await dispatch(separator, pointer("pointerdown", 880));
  await dispatch(separator, pointer("pointerup", 760));
  expect(width()).toBe(440);
  expect(localStorage.getItem(STORAGE_KEY)).toBe("440");
  separator = divider();
  await dispatch(separator, pointer("pointerdown", 760));
  await dispatch(separator, pointer("pointermove", 700));
  await dispatch(separator, pointer("pointerup", 600));
  expect(width()).toBe(600);
  expect(localStorage.getItem(STORAGE_KEY)).toBe("600");
  expect(frames.size).toBe(0);
});

test("keyboard and pointer share width bounds while preserving the main area", async () => {
  await render();
  const separator = divider();
  separator.focus();
  await key(separator, "ArrowLeft");
  expect(width()).toBe(336);
  await key(separator, "ArrowRight");
  expect(width()).toBe(320);
  await key(separator, "End");
  expect(width()).toBe(780);
  await key(separator, "ArrowLeft");
  expect(width()).toBe(780);
  await key(separator, "Home");
  expect(width()).toBe(220);
  await dispatch(separator, pointer("pointerdown", 980));
  await dispatch(separator, pointer("pointermove", -3000));
  await flushFrame();
  expect(width()).toBe(780);
  await dispatch(separator, pointer("pointermove", 4000));
  await dispatch(separator, pointer("pointerup", 4000));
  expect(width()).toBe(220);
});

test.each(["pointercancel", "lostpointercapture", "blur", "close"])(
  "%s restores the original preference and permits another drag",
  async (ending) => {
    await render();
    let separator = divider();
    await dispatch(separator, pointer("pointerdown", 880));
    await dispatch(separator, pointer("pointermove", 700));
    await flushFrame();
    expect(width()).toBe(500);
    if (ending === "blur") await dispatch(window, new Event("blur"));
    else if (ending === "close") await render(false);
    else await dispatch(separator, pointer(ending, 700));
    expect(captured.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await render();
    expect(width()).toBe(320);
    separator = divider();
    await dispatch(separator, pointer("pointerdown", 880, 2));
    await dispatch(separator, pointer("pointermove", 800, 2));
    await dispatch(separator, pointer("pointerup", 800, 2));
    expect(width()).toBe(400);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("400");
  },
);

test("unmount releases capture, queued frame, body styles and blur listener", async () => {
  await render();
  const separator = divider();
  const remove = vi.spyOn(window, "removeEventListener");
  await dispatch(separator, pointer("pointerdown", 880));
  await dispatch(separator, pointer("pointermove", 700));
  expect(frames.size).toBe(1);
  await act(async () => root.unmount());
  expect(captured.size).toBe(0);
  expect(frames.size).toBe(0);
  expect(document.body.style.userSelect).toBe("");
  expect(document.body.style.cursor).toBe("");
  expect(remove.mock.calls.some(([type]) => type === "blur")).toBe(true);
  await dispatch(window, new Event("blur"));
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  root = createRoot(host);
  await render();
  expect(width()).toBe(320);
});

test("viewport clamping is temporary and does not replace the saved preference", async () => {
  localStorage.setItem(STORAGE_KEY, "600");
  await render();
  expect(width()).toBe(600);
  available = 640;
  await dispatch(window, new Event("resize"));
  expect(width()).toBe(220);
  expect(localStorage.getItem(STORAGE_KEY)).toBe("600");
  // Pressing and releasing without moving must not save the temporary clamp.
  const separator = divider();
  await dispatch(separator, pointer("pointerdown", 420));
  await dispatch(separator, pointer("pointerup", 420));
  expect(localStorage.getItem(STORAGE_KEY)).toBe("600");
  available = 1200;
  await dispatch(window, new Event("resize"));
  expect(width()).toBe(600);
  available = 300;
  await dispatch(window, new Event("resize"));
  expect(width()).toBe(90);
  expect(width()).toBeLessThan(available);
  available = 1200;
  await dispatch(window, new Event("resize"));
  expect(width()).toBe(600);
});

test("layout preference survives remount and children remain mounted while resizing", async () => {
  function Content() {
    const [count, setCount] = useState(0);
    return createElement("button", { onClick: () => setCount(count + 1) }, `Count ${count}`);
  }
  await render(true, createElement(Content));
  await act(async () => document.querySelector("button")!.click());
  const separator = divider();
  await key(separator, "ArrowLeft");
  expect(document.querySelector("button")!.textContent).toBe("Count 1");
  await render(false, createElement(Content));
  await render(true, createElement(Content));
  expect(document.querySelector("button")!.textContent).toBe("Count 1");
  expect(width()).toBe(336);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(width()).toBe(336);
});

test("parent resize observation reclamps without committing an interrupted gesture", async () => {
  let notify = () => {};
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  localStorage.setItem(STORAGE_KEY, "600");
  await render();
  expect(observe).toHaveBeenCalledExactlyOnceWith(host);
  const separator = divider();
  await dispatch(separator, pointer("pointerdown", 600));
  await dispatch(separator, pointer("pointermove", 500));
  await flushFrame();
  expect(width()).toBe(700);
  available = 640;
  await act(async () => notify());
  expect(width()).toBe(220);
  expect(captured.size).toBe(0);
  expect(localStorage.getItem(STORAGE_KEY)).toBe("600");
  available = 1200;
  await act(async () => notify());
  expect(width()).toBe(600);
  await act(async () => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  root = createRoot(host);
});

test("invalid preferences and unavailable storage do not prevent resizing", async () => {
  localStorage.setItem(STORAGE_KEY, "Infinity");
  await render();
  expect(width()).toBe(320);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  await key(divider(), "ArrowLeft");
  expect(width()).toBe(336);
  await render(false);
  await render(true);
  expect(width()).toBe(336);
});

test("wrong pointer and secondary button cannot resize or finish the active gesture", async () => {
  await render();
  const separator = divider();
  await dispatch(separator, pointer("pointerdown", 880, 1, 2));
  expect(captured.size).toBe(0);
  await dispatch(separator, pointer("pointerdown", 880));
  await dispatch(separator, pointer("pointermove", 700, 2));
  await dispatch(separator, pointer("pointerup", 700, 2));
  expect(width()).toBe(320);
  expect(captured.has(1)).toBe(true);
  await dispatch(separator, pointer("pointermove", 800));
  await dispatch(separator, pointer("pointerup", 800));
  expect(width()).toBe(400);
});
