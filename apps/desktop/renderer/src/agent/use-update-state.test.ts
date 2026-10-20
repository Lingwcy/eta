// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { UpdateState } from "../../../src/bridge.ts";
import { useUpdateState } from "./use-update-state";

let root: Root;
let push: (state: UpdateState) => void;
let initial: ReturnType<typeof Promise.withResolvers<UpdateState>>;
let view: ReturnType<typeof useUpdateState> | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const listeners = new Set<(state: UpdateState) => void>();
  initial = Promise.withResolvers<UpdateState>();
  vi.stubGlobal("eta", {
    subscribeUpdate: (listener: (state: UpdateState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateState: () => initial.promise,
  });
  push = (state) => {
    for (const listener of listeners) listener(state);
  };
  function Host() {
    view = useUpdateState();
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(Host)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test("a command reply applies only when no push arrived after it was captured", async () => {
  await act(async () => push({ status: "downloaded", version: "1.2.3" }));
  expect(view![0]).toEqual({ status: "downloaded", version: "1.2.3" });
  const current = view![1].capture();
  await act(async () => view![1].apply({ status: "available", version: "1.2.3" }, current));
  expect(view![0]).toEqual({ status: "available", version: "1.2.3" });
  const stale = view![1].capture();
  await act(async () => push({ status: "downloaded", version: "1.2.4" }));
  await act(async () => view![1].apply({ status: "available", version: "1.2.3" }, stale));
  expect(view![0]).toEqual({ status: "downloaded", version: "1.2.4" });
});

test("the initial read still applies when nothing has been pushed", async () => {
  await act(async () => initial.resolve({ status: "idle" }));
  expect(view![0]).toEqual({ status: "idle" });
});
