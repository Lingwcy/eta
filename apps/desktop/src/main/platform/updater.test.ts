import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { UpdateState } from "../../bridge.ts";
import { createUpdater } from "./updater.ts";

class FakeBackend extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn(async () => {
    this.emit("checking-for-update");
    return null;
  });
  quitAndInstall = vi.fn();
}

function fixture(autoCheck = false) {
  const backend = new FakeBackend();
  const states: UpdateState[] = [];
  const updater = createUpdater({
    backend: backend as unknown as Parameters<typeof createUpdater>[0]["backend"],
    autoCheck,
    broadcast: (state) => states.push(state),
  });
  return { backend, states, updater };
}

afterEach(() => {
  vi.useRealTimers();
});

test("development builds report unsupported and never schedule checks", async () => {
  vi.useFakeTimers();
  const updater = createUpdater({ backend: undefined, autoCheck: true, broadcast: () => {} });
  expect(await updater.check()).toEqual({ status: "unsupported" });
  expect(vi.getTimerCount()).toBe(0);
  expect(() => updater.install()).toThrow();
});

test("a found update downloads in the background and becomes installable", async () => {
  const { backend, states, updater } = fixture();
  expect(backend.autoDownload).toBe(true);
  await updater.check();
  backend.emit("update-available", { version: "0.0.3" });
  backend.emit("download-progress", { percent: 12.2 });
  backend.emit("download-progress", { percent: 12.9 });
  backend.emit("download-progress", { percent: 40.1 });
  backend.emit("update-downloaded", { version: "0.0.3" });
  expect(states).toEqual([
    { status: "checking" },
    { status: "available", version: "0.0.3" },
    { status: "downloading", version: "0.0.3", percent: 12 },
    { status: "downloading", version: "0.0.3", percent: 40 },
    { status: "downloaded", version: "0.0.3" },
  ]);
  updater.install();
  expect(backend.quitAndInstall).toHaveBeenCalledOnce();
});

test("later checks do not hide an update that is ready to install", async () => {
  const { backend, updater } = fixture();
  backend.emit("update-downloaded", { version: "0.0.3" });
  await updater.check();
  backend.emit("error", new Error("offline"));
  expect(backend.checkForUpdates).not.toHaveBeenCalled();
  expect(updater.state()).toEqual({ status: "downloaded", version: "0.0.3" });
});

test("failures keep only the first line and point at the release page", async () => {
  const { backend, updater } = fixture();
  backend.checkForUpdates.mockImplementationOnce(async () => {
    const error = new Error("HttpError: 404\nHeaders: {...}");
    backend.emit("error", error);
    throw error;
  });
  const state = await updater.check();
  expect(state).toMatchObject({ status: "error", message: "检查更新失败：HttpError: 404" });
  expect(state.status === "error" && state.releaseUrl).toContain("/releases/latest");
});

test("turning automatic checks off stops the schedule, and back on restores it", async () => {
  vi.useFakeTimers();
  const { backend, updater } = fixture(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(backend.checkForUpdates).toHaveBeenCalledOnce();
  backend.emit("update-not-available");
  updater.setAutoCheck(false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
  expect(backend.checkForUpdates).toHaveBeenCalledOnce();
  updater.setAutoCheck(true);
  expect(vi.getTimerCount()).toBe(2);
  // Saving unrelated settings repeats the same value and must not restart the cadence.
  updater.setAutoCheck(true);
  expect(vi.getTimerCount()).toBe(2);
});
