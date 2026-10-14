import { expect, test, vi } from "vite-plus/test";
import { createBackgroundResidence } from "./background.ts";

test("Windows defaults to exit, requires a visible tray to stay alive, and has a reversible setting", () => {
  const destroy = vi.fn();
  const quit = vi.fn();
  const open = vi.fn();
  let count = 1;
  const createTray = vi.fn((_open: () => void, _quit: () => void) => ({ destroy }));
  const background = createBackgroundResidence({
    platform: "win32",
    createTray,
    quit,
    open,
    windowCount: () => count,
  });
  expect(background.keepRunning()).toBe(false);
  background.configure(true);
  background.configure(true);
  expect(createTray).toHaveBeenCalledTimes(1);
  expect(background.keepRunning()).toBe(true);
  createTray.mock.calls[0][0]();
  expect(open).toHaveBeenCalledTimes(1);
  createTray.mock.calls[0][1]();
  expect(quit).toHaveBeenCalledTimes(1);
  count = 0;
  background.configure(false);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(background.keepRunning()).toBe(false);
  expect(quit).toHaveBeenCalledTimes(2);
  background.configure(true);
  background.dispose();
  expect(background.keepRunning()).toBe(false);
  expect(destroy).toHaveBeenCalledTimes(2);
  background.configure(true);
  expect(createTray).toHaveBeenCalledTimes(2);
});
test("a failed tray cannot leave an invisible Windows resident process", () => {
  const background = createBackgroundResidence({
    platform: "win32",
    createTray: () => {
      throw new Error("missing icon");
    },
    open: () => {},
    quit: () => {},
    windowCount: () => 1,
  });
  expect(() => background.configure(true)).toThrow("missing icon");
  expect(background.keepRunning()).toBe(false);
});
test.each(["darwin", "linux"])(
  "%s keeps existing close-window behavior and never creates a tray",
  (platform) => {
    const createTray = vi.fn(() => ({ destroy: () => {} }));
    const background = createBackgroundResidence({
      platform,
      createTray,
      open: () => {},
      quit: () => {},
      windowCount: () => 0,
    });
    background.configure(true);
    expect(createTray).not.toHaveBeenCalled();
    expect(background.keepRunning()).toBe(platform === "darwin");
  },
);
