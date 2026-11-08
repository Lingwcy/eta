import { parseInitialAppearance } from "../../preload-appearance.ts";
import { EventEmitter } from "node:events";
import { expect, test } from "vite-plus/test";
import { createAppearanceController } from "./appearance.ts";
import {
  resolveTheme,
  themePreferences,
  type AppearanceSnapshot,
  type ThemePreference,
} from "../../appearance.ts";

class Native extends EventEmitter {
  systemDark = false;
  private source: ThemePreference = "system";
  get themeSource() {
    return this.source;
  }
  set themeSource(value: ThemePreference) {
    this.source = value;
    this.emit("updated");
  }
  get shouldUseDarkColors() {
    return resolveTheme(this.source, this.systemDark) === "dark";
  }
  system(dark: boolean) {
    this.systemDark = dark;
    this.emit("updated");
  }
}

test.each(themePreferences)("%s resolves against either OS appearance", (preference) => {
  for (const dark of [true, false]) {
    expect(resolveTheme(preference, dark)).toBe(
      preference === "system" ? (dark ? "dark" : "light") : preference,
    );
  }
});

test("system changes, explicit overrides and returning to system share a monotonic snapshot", () => {
  const native = new Native();
  const events: AppearanceSnapshot[] = [];
  const controller = createAppearanceController(native, (value) => events.push(value));
  try {
    native.system(true);
    expect(controller.snapshot()).toEqual({ preference: "system", resolved: "dark", revision: 1 });
    native.system(true);
    expect(events).toHaveLength(1);
    controller.configure("light");
    expect(native.themeSource).toBe("light");
    native.system(false);
    native.system(true);
    expect(controller.snapshot()).toEqual({ preference: "light", resolved: "light", revision: 2 });
    controller.configure("dark");
    controller.configure("dark");
    expect(events).toHaveLength(3);
    controller.configure("system");
    expect(controller.snapshot()).toEqual({ preference: "system", resolved: "dark", revision: 4 });
    native.system(false);
    expect(controller.snapshot()).toEqual({ preference: "system", resolved: "light", revision: 5 });
    events[0]!.resolved = "light";
    expect(controller.snapshot().revision).toBe(5);
  } finally {
    controller.dispose();
  }
  native.system(true);
  controller.configure("dark");
  expect(events).toHaveLength(5);
  expect(native.listenerCount("updated")).toBe(0);
});

test("sandbox bootstrap accepts only consistent enums and safe revisions", () => {
  expect(parseInitialAppearance(["--eta-appearance=system:dark:12"])).toEqual({
    preference: "system",
    resolved: "dark",
    revision: 12,
  });
  for (const value of [
    "dark:light:1",
    "unknown:dark:2",
    "light:light:Infinity",
    "system:dark:-1",
    "dark:dark:9007199254740992",
    "dark:dark:1junk",
    "system:dark:1:extra",
    "dark:dark:1=x",
  ]) {
    expect(parseInitialAppearance(["--eta-appearance=" + value])).toEqual({
      preference: "system",
      resolved: "light",
      revision: 0,
    });
  }
});
