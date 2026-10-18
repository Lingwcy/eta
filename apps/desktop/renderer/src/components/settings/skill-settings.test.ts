// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vite-plus/test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { DesktopSettings } from "../../../../src/shared/settings.ts";
import type { SkillCatalog } from "@eta/core/skills/types";
import { t } from "@/i18n";
import { ToastProvider } from "@/components/ui/toast";
import { SkillSettings } from "./skill-settings";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const catalog = (scope: string, enabled = true): SkillCatalog => ({
  directories: [{ path: scope + "/.agents/skills", source: "project" }],
  skills: [
    {
      id: scope + "/.agents/skills/foo/SKILL.md",
      name: "Foo",
      path: scope + "/.agents/skills/foo/SKILL.md",
      directory: scope + "/.agents/skills/foo",
      description: "Test skill",
      source: "project",
      enabled,
    },
  ],
  issues: [],
});
const library: DesktopLibrary = {
  projects: ["/a", "/b"].map((path) => ({
    id: path,
    name: path,
    rootPath: path,
    environmentId: "local",
    createdAt: 1,
  })),
  workspaces: ["/a", "/b"].map((path) => ({
    id: path,
    projectId: path,
    kind: "project-root",
    cwd: path,
    createdAt: 1,
  })),
  settings: { defaultThinkingLevel: "off", disabledSkills: [] },
  threads: [],
  models: [],
  providers: [],
  credentials: [],
};
const toggle = (enabled: boolean) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) =>
      button.getAttribute("aria-label") ===
      t(enabled ? "settings:skillSettings.disable" : "settings:skillSettings.enable") + " Foo",
  );
async function choose(cwd: string) {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === t("settings:skillSettings.skillProjectScope"),
  );
  expect(trigger).toBeDefined();
  await act(async () => trigger!.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (entry) => entry.textContent === cwd,
  );
  expect(option).toBeDefined();
  await act(async () => option!.click());
}

test.each([false, true].flatMap((reject) => [false, true].map((enabled) => ({ reject, enabled }))))(
  "old skill scope cannot be changed while its replacement is pending or failed (reject=$reject, enabled=$enabled)",
  async ({ reject, enabled }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const replacement = Promise.withResolvers<SkillCatalog>();
    let requests = 0;
    const skills = vi.fn(async (cwd?: string) => {
      if (cwd === "/b" && ++requests === 1) return replacement.promise;
      return cwd ? catalog(cwd, enabled) : { directories: [], skills: [], issues: [] };
    });
    vi.stubGlobal("eta", { skills });
    const updates: Partial<DesktopSettings>[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    try {
      await act(async () =>
        root!.render(
          createElement(
            ToastProvider,
            null,
            createElement(SkillSettings, {
              library: {
                ...library,
                settings: {
                  ...library.settings,
                  disabledSkills: enabled
                    ? []
                    : ["/a/.agents/skills/foo/SKILL.md", "/b/.agents/skills/foo/SKILL.md"],
                },
              },
              busy: false,
              active: true,
              onChange: async (patch) => {
                updates.push(patch);
              },
            }),
          ),
        ),
      );
      await choose("/a");
      const old = toggle(enabled);
      expect(old).toBeDefined();
      await choose("/b");
      expect(skills).toHaveBeenLastCalledWith("/b");
      if (!reject) {
        await act(async () => old!.click());
        expect(updates).toEqual([]);
        expect(toggle(enabled)).toBeUndefined();
      }
      await act(async () => {
        if (reject) replacement.reject(new Error("Replacement failed"));
        else replacement.resolve(catalog("/b", enabled));
      });
      if (reject) {
        await act(async () => old!.click());
        expect(updates).toEqual([]);
        expect(toggle(enabled)).toBeUndefined();
        const refresh = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === t("settings:skillSettings.refresh"),
        );
        expect(refresh).toBeDefined();
        await act(async () => refresh!.click());
      }
      const current = toggle(enabled);
      expect(current).toBeDefined();
      expect(current!.disabled).toBe(false);
      await act(async () => current!.click());
      expect(updates).toEqual([
        {
          disabledSkills: enabled
            ? ["/b/.agents/skills/foo/SKILL.md"]
            : ["/a/.agents/skills/foo/SKILL.md"],
        },
      ]);
    } finally {
      await act(async () => {
        replacement.resolve(catalog("/b", enabled));
        await replacement.promise.catch(() => {});
        root?.unmount();
      });
      root = undefined;
    }
  },
);

test.each([false, true])(
  "skill changes wait for a same-scope refresh (enabled=%s)",
  async (enabled) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const replacement = Promise.withResolvers<SkillCatalog>();
    let requests = 0;
    const skills = vi.fn(async (cwd?: string) => {
      if (cwd === "/a" && ++requests === 2) return replacement.promise;
      return cwd ? catalog(cwd, enabled) : { directories: [], skills: [], issues: [] };
    });
    vi.stubGlobal("eta", { skills });
    const updates: Partial<DesktopSettings>[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    try {
      await act(async () =>
        root!.render(
          createElement(
            ToastProvider,
            null,
            createElement(SkillSettings, {
              library: {
                ...library,
                settings: {
                  ...library.settings,
                  disabledSkills: enabled ? [] : ["/a/.agents/skills/foo/SKILL.md"],
                },
              },
              busy: false,
              active: true,
              onChange: async (patch) => {
                updates.push(patch);
              },
            }),
          ),
        ),
      );
      await choose("/a");
      const old = toggle(enabled);
      expect(old).toBeDefined();
      const refresh = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === t("settings:skillSettings.refresh"),
      );
      expect(refresh).toBeDefined();
      await act(async () => refresh!.click());
      expect(skills).toHaveBeenLastCalledWith("/a");
      await act(async () => old!.click());
      expect(updates).toEqual([]);
      await act(async () => replacement.resolve(catalog("/a", enabled)));
      expect(toggle(enabled)!.disabled).toBe(false);
      await act(async () => toggle(enabled)!.click());
      expect(updates).toEqual([
        { disabledSkills: enabled ? ["/a/.agents/skills/foo/SKILL.md"] : [] },
      ]);
    } finally {
      await act(async () => {
        replacement.resolve(catalog("/a", enabled));
        await replacement.promise;
        root?.unmount();
      });
      root = undefined;
    }
  },
);
