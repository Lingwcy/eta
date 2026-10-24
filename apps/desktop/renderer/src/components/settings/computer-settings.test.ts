// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { setup } from "../../../../src/main/tests/runtime-fixture.ts";
import { dispatchCommand } from "../../../../src/main/ipc.ts";
import type { DesktopApplication } from "../../../../src/main/bootstrap.ts";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { DesktopLibraryClient } from "@/desktop/library-client";
import { settingsPanels } from "./settings-panels";
import { t } from "@/i18n";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test("the permissions control persists its grant through IPC, allows images and revokes the grant", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const f = await setup();
  await f.runtime.runPromise(f.settings.update({ blockImages: true, agentMode: "standard" }));
  const application = {
    updateSettings: (patch) => f.runtime.runPromise(f.settings.update(patch)),
  } satisfies Pick<DesktopApplication, "updateSettings">;
  const bridge = {
    library: async (): Promise<DesktopLibrary> => ({
      projects: [],
      workspaces: [],
      threads: [],
      models: [
        {
          id: "vision",
          provider: "test",
          name: "Test Vision",
          thinkingLevels: ["off"],
          contextWindow: 10000,
          input: ["text", "image"],
        },
      ],
      providers: [{ id: "test", name: "Test", methods: ["api_key"] }],
      credentials: [],
      settings: await f.runtime.runPromise(f.settings.read),
    }),
    updateSettings: async (patch: Parameters<DesktopApplication["updateSettings"]>[0]) =>
      dispatchCommand(application as DesktopApplication, { type: "settings", patch }) as ReturnType<
        DesktopApplication["updateSettings"]
      >,
    subscribeLibrary: (notify: () => void) => f.settings.subscribe(notify),
    computerStatus: vi.fn(async () => ({ status: "ready", screen: true, accessibility: true })),
    reviewStats: async () => ({ reviews: 0 }),
  };
  vi.stubGlobal("eta", bridge);
  const client = new DesktopLibraryClient(bridge);
  const View = () => {
    const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
    if (!state.library) return null;
    return settingsPanels.permissions({
      library: state.library,
      busy: state.busy,
      active: true,
      updateSettings: (patch) => client.updateSettings(patch),
      act: (action) => action(),
      reconnect() {},
      refreshAuthentication: async () => {},
    });
  };
  document.body.append(document.createElement("div"));
  root = createRoot(document.body.firstElementChild!);
  try {
    await act(async () => {
      client.connect();
      root!.render(createElement(View));
    });
    const toggle = () =>
      document.querySelector<HTMLButtonElement>(
        `button[aria-label="${t("settings:permissionSettings.computerUse")}"]`,
      )!;
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      toggle().click();
      await expect.poll(() => client.getSnapshot().busy).toBe(false);
    });
    expect(await f.runtime.runPromise(f.settings.read)).toMatchObject({
      computerUse: true,
      blockImages: false,
    });
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      toggle().click();
      await expect.poll(() => client.getSnapshot().busy).toBe(false);
    });
    expect((await f.runtime.runPromise(f.settings.read)).computerUse).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  } finally {
    client.dispose();
  }
});
