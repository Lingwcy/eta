// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { DesktopBridge } from "../../../../src/bridge.ts";
import type { ImageAttachment } from "@eta/core/images/types";
import { CompositeInput } from "./composite-input";
import type { CompositeInputProps } from "./types";
import { ToastProvider } from "@/components/ui/toast";
import { i18n } from "@/i18n";

const NativeReader = FileReader;
let readers: ControlledReader[] = [];
class ControlledReader extends NativeReader {
  file?: Blob;
  done = false;
  override readAsDataURL(file: Blob) {
    this.file = file;
    readers.push(this);
  }
  finish(fail = false) {
    if (this.done) return;
    this.done = true;
    Object.defineProperty(this, "result", { value: "data:image/png;base64,AA==" });
    this.dispatchEvent(new ProgressEvent(fail ? "error" : "load"));
  }
}
function image(name: string): ImageAttachment {
  return { type: "image", mimeType: "image/png", data: "AA==", name };
}
let root: Root;
let unmounted: boolean;
let gate: ReturnType<typeof Promise.withResolvers<ImageAttachment>>;
let prepare: ReturnType<typeof vi.fn<DesktopBridge["prepareImage"]>>;
let submit = vi.fn<NonNullable<CompositeInputProps["onSubmit"]>>();
let previousLanguage: string;
const originalAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("FileReader", ControlledReader);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  previousLanguage = i18n.language;
  await i18n.changeLanguage("en");
  readers = [];
  gate = Promise.withResolvers<ImageAttachment>();
  prepare = vi.fn<DesktopBridge["prepareImage"]>(async (source) =>
    image("name" in source ? source.name : source.path),
  );
  submit = vi.fn<NonNullable<CompositeInputProps["onSubmit"]>>(async () => {});
  vi.stubGlobal("eta", { prepareImage: prepare });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  unmounted = false;
  await act(async () =>
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(CompositeInput, { defaultValue: "Describe", onSubmit: submit }),
      ),
    ),
  );
});
afterEach(async () => {
  await act(async () => {
    if (!unmounted) root.unmount();
  });
  await act(async () => {
    gate.resolve(image("first.png"));
    for (const reader of readers) reader.finish();
    await Promise.resolve();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  if (originalAnimations)
    Object.defineProperty(HTMLElement.prototype, "getAnimations", originalAnimations);
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  await i18n.changeLanguage(previousLanguage);
});
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error("Missing button " + label);
  return found;
}
function remove(name: string) {
  button(i18n.t("chat:imageAttachments.remove", { name })).click();
}
async function add(files: File[], entry: "picker" | "paste" | "drop" = "picker") {
  await act(async () => {
    if (entry === "picker") {
      const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(picker, "files", { configurable: true, value: files });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const event = new Event(entry, { bubbles: true, cancelable: true });
      Object.defineProperty(event, entry === "paste" ? "clipboardData" : "dataTransfer", {
        value: { files, types: ["Files"] },
      });
      document.querySelector("textarea")!.dispatchEvent(event);
    }
  });
}
function file(name: string) {
  return new File(["fixture"], name, { type: "image/png" });
}
async function send(expected: ImageAttachment[]) {
  const send = button(i18n.t("chat:actionToolbar.sendMessage"));
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  expect(submit).toHaveBeenCalledWith("Describe", expected);
}
const cases = (["read", "prepare"] as const).flatMap((phase) =>
  (["current", "remove", "unmount"] as const).flatMap((action) =>
    [false, true].map((fail) => ({ phase, action, fail })),
  ),
);
test.each(cases)(
  "attachment continuation: $phase $action failure=$fail",
  async ({ phase, action, fail }) => {
    if (phase === "prepare")
      prepare.mockImplementation(async (source) =>
        "name" in source && source.name === "first.png" ? gate.promise : image("second.png"),
      );
    await add([file("first.png")]);
    expect(readers).toHaveLength(1);
    if (phase === "prepare") {
      await act(async () => readers[0]!.finish());
      expect(prepare).toHaveBeenCalledOnce();
    }
    if (action === "remove") await act(async () => remove("first.png"));
    if (action === "unmount")
      await act(async () => {
        root.unmount();
        unmounted = true;
      });
    await act(async () => {
      if (phase === "read") readers[0]!.finish(fail);
      else if (fail) gate.reject(new Error("Cannot decode first image"));
      else gate.resolve(image("first.png"));
    });
    const error =
      phase === "read"
        ? i18n.t("chat:compositeInput.cannotReadTheImage")
        : "Cannot decode first image";
    if (action === "current") {
      if (fail) {
        expect(document.body.textContent).toContain(error);
        expect(button(i18n.t("chat:actionToolbar.sendMessage")).disabled).toBe(true);
      } else {
        expect(document.querySelector('img[alt="first.png"]')).not.toBeNull();
        await send([image("first.png")]);
      }
      return;
    }
    expect(document.body.textContent).not.toContain(error);
    if (phase === "read") expect(prepare).not.toHaveBeenCalled();
    if (action === "remove") {
      await add([file("second.png")]);
      await act(async () => readers[1]!.finish());
      expect(document.querySelector('img[alt="second.png"]')).not.toBeNull();
      await send([image("second.png")]);
    }
  },
);

test.each([false, true])(
  "removing a queued attachment skips its read but continues the batch, first fails=%s",
  async (fail) => {
    const first = file("first.png"),
      second = file("second.png"),
      third = file("third.png");
    await add([first, second, third], fail ? "paste" : "drop");
    expect(readers).toHaveLength(1);
    await act(async () => remove("second.png"));
    await act(async () => readers[0]!.finish(fail));
    expect(readers[1]?.file).toBe(third);
    await act(async () => readers[1]!.finish());
    expect(document.querySelector('img[alt="third.png"]')).not.toBeNull();
    if (fail) await act(async () => remove("first.png"));
    await send(fail ? [image("third.png")] : [image("first.png"), image("third.png")]);
    expect(
      prepare.mock.calls.every(([source]) => !("name" in source) || source.name !== "second.png"),
    ).toBe(true);
  },
);
