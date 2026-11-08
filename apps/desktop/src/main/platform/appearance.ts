import { resolveTheme, type AppearanceSnapshot, type ThemePreference } from "../../appearance.ts";

type NativeAppearance = {
  themeSource: ThemePreference;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): unknown;
  removeListener(event: "updated", listener: () => void): unknown;
};

/** Own native appearance once per app, including while all windows are closed. */
export function createAppearanceController(
  native: NativeAppearance,
  publish: (snapshot: AppearanceSnapshot) => void,
) {
  let current: AppearanceSnapshot = {
    preference: "system",
    resolved: resolveTheme("system", native.shouldUseDarkColors),
    revision: 0,
  };
  let disposed = false;
  const refresh = () => {
    if (disposed) return;
    const resolved = resolveTheme(current.preference, native.shouldUseDarkColors);
    if (resolved === current.resolved) return;
    current = { ...current, resolved, revision: current.revision + 1 };
    publish({ ...current });
  };
  native.on("updated", refresh);
  return {
    snapshot: () => ({ ...current }),
    configure(preference: ThemePreference) {
      if (disposed) return;
      if (current.preference === preference && native.themeSource === preference) {
        refresh();
        return;
      }
      const previous = current;
      // Native setters may synchronously emit updated; publish one coherent snapshot below.
      native.removeListener("updated", refresh);
      native.themeSource = preference;
      current = {
        preference,
        resolved: resolveTheme(preference, native.shouldUseDarkColors),
        revision: previous.revision,
      };
      native.on("updated", refresh);
      if (previous.preference !== preference || previous.resolved !== current.resolved) {
        current = { ...current, revision: current.revision + 1 };
        publish({ ...current });
      }
    },
    dispose() {
      disposed = true;
      native.removeListener("updated", refresh);
    },
  };
}
