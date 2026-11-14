// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { MobileUpdater, UpdateSnapshot } from "../updater.ts";

vi.mock("../ui.tsx", () => ({
  colors: { border: "#e4e4e7", ink: "#09090b", muted: "#71717a", soft: "#f4f4f5", surface: "#fff" },
  radii: { md: 12, full: 999 },
}));
vi.mock("../motion.tsx", async () => {
  const React = await import("react");
  return {
    SpringPressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityRole,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityRole?: string;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          onClick: onPress,
        },
        children,
      ),
  };
});
vi.mock("lucide-react-native", () => ({
  ArrowDownToLine: () => null,
  X: () => null,
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityRole,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityRole?: string;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          onClick: onPress,
        },
        children,
      ),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("span", {}, children),
    View: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", {}, children),
  };
});

import { UpdateBanner } from "./update-banner.tsx";

let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function fakeUpdater(): MobileUpdater {
  return {
    getSnapshot: () => ({}) as UpdateSnapshot,
    subscribe: () => () => {},
    start: () => {},
    check: async () => ({ status: "idle" }),
    downloadAndInstall: vi.fn(async () => {}),
    cancelDownload: vi.fn(),
    install: vi.fn(async () => {}),
    requestInstallPermission: vi.fn(async () => {}),
    openReleasePage: vi.fn(async () => {}),
    dismissBanner: vi.fn(),
    setAutoCheck: vi.fn(),
    onForeground: async () => {},
    applyPreferences: vi.fn(),
    dispose: vi.fn(),
  };
}

test("UpdateBanner renders download/dismiss controls and hides dismissed release versions", async () => {
  const updater = fakeUpdater();
  const base: UpdateSnapshot = {
    currentVersion: "0.1.0",
    platform: "android",
    supportsInAppInstall: true,
    autoCheck: true,
    state: {
      status: "available",
      release: {
        version: "0.2.0",
        tag: "mobile-v0.2.0",
        releaseUrl: "https://github.com/Lingwcy/eta/releases/tag/mobile-v0.2.0",
        downloadUrl: "https://example.com/app.apk",
      },
    },
  };

  await act(async () => root.render(createElement(UpdateBanner, { update: base, updater })));
  expect(document.body.textContent).toContain("0.2.0");

  const downloadBtn = document.querySelector("button[aria-label='Download']") as HTMLButtonElement;
  await act(async () => downloadBtn.click());
  expect(updater.downloadAndInstall).toHaveBeenCalledOnce();

  const dismissBtn = document.querySelector(
    "button[aria-label='Dismiss update notice']",
  ) as HTMLButtonElement;
  await act(async () => dismissBtn.click());
  expect(updater.dismissBanner).toHaveBeenCalledOnce();

  await act(async () =>
    root.render(
      createElement(UpdateBanner, { update: { ...base, dismissedVersion: "0.2.0" }, updater }),
    ),
  );
  expect(document.body.textContent).toBe("");
});

test("UpdateBanner renders downloading progress without dismiss button and install action when ready", async () => {
  const updater = fakeUpdater();
  const release = {
    version: "0.2.0",
    tag: "mobile-v0.2.0",
    releaseUrl: "https://github.com/Lingwcy/eta/releases/tag/mobile-v0.2.0",
  };

  await act(async () =>
    root.render(
      createElement(UpdateBanner, {
        updater,
        update: {
          currentVersion: "0.1.0",
          platform: "android",
          supportsInAppInstall: true,
          autoCheck: true,
          state: { status: "downloading", release, percent: 62, bytesWritten: 62, totalBytes: 100 },
        },
      }),
    ),
  );
  expect(document.body.textContent).toContain("62%");
  expect(document.querySelector("button[aria-label='Dismiss update notice']")).toBeNull();
  await act(async () =>
    (document.querySelector("button[aria-label='Cancel']") as HTMLButtonElement).click(),
  );
  expect(updater.cancelDownload).toHaveBeenCalledOnce();

  await act(async () =>
    root.render(
      createElement(UpdateBanner, {
        updater,
        update: {
          currentVersion: "0.1.0",
          platform: "android",
          supportsInAppInstall: true,
          autoCheck: true,
          state: { status: "downloaded", release, fileUri: "file:///cache/app.apk" },
        },
      }),
    ),
  );
  await act(async () =>
    (document.querySelector("button[aria-label='Install']") as HTMLButtonElement).click(),
  );
  expect(updater.install).toHaveBeenCalledOnce();
});
