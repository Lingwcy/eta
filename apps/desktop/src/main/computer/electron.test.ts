import { afterEach, expect, test, vi } from "vite-plus/test";

const host = vi.hoisted(() => ({
  sources: vi.fn<() => Promise<{ display_id: string; thumbnail: unknown }[]>>(async () => []),
  screen: vi.fn(() => "not-determined"),
  accessibility: vi.fn(() => false),
  open: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({
  app: { getAppPath: () => "/tmp/eta-computer-test" },
  screen: {
    getPrimaryDisplay: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      scaleFactor: 2,
      rotation: 0,
    }),
  },
  desktopCapturer: { getSources: host.sources },
  systemPreferences: {
    getMediaAccessStatus: host.screen,
    isTrustedAccessibilityClient: host.accessibility,
  },
  shell: { openExternal: host.open },
}));
vi.mock("./overlay-process.ts", () => ({
  createComputerOverlayProcess: () => ({ update() {}, dispose() {} }),
}));
import { createElectronComputer } from "./electron.ts";

afterEach(() => {
  vi.clearAllMocks();
  host.screen.mockReturnValue("not-determined");
  host.accessibility.mockReturnValue(false);
  host.sources.mockResolvedValue([]);
});

test.skipIf(process.platform !== "darwin")(
  "rejects an untargeted screenshot without capturing the user's desktop",
  async () => {
    host.screen.mockReturnValue("granted");
    host.accessibility.mockReturnValue(true);
    const capability = createElectronComputer()!;
    const owner = { active: () => true };
    try {
      await expect(
        capability.service.screenshot(owner, AbortSignal.timeout(5000)),
      ).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      await capability.service.release(owner);
    }
    expect(host.sources).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform !== "darwin")(
  "first-use screen access is explicitly requested without thumbnail pixels before opening System Settings",
  async () => {
    const capability = createElectronComputer()!;
    expect(host.sources).not.toHaveBeenCalled();
    await capability.openPermissions("screen");
    expect(host.sources).toHaveBeenCalledWith({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    expect(host.open).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  },
);

test.skipIf(process.platform !== "darwin")(
  "accessibility prompts only for the explicit permission action",
  async () => {
    const capability = createElectronComputer()!;
    expect(host.accessibility).not.toHaveBeenCalled();
    await capability.openPermissions("accessibility");
    expect(host.accessibility).toHaveBeenCalledWith(true);
    expect(host.sources).not.toHaveBeenCalled();
    expect(host.open).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  },
);
