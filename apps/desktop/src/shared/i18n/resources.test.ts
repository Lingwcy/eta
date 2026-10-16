import { expect, test } from "vite-plus/test";
import { createDesktopI18n } from "./create-i18n.ts";
import { resources } from "./resources.ts";
import { locales } from "./locales.ts";

const placeholders = (text: string) =>
  [...text.matchAll(/{{\s*([^}]+?)\s*}}/g)].map((match) => match[1]).sort();
const baseKey = (key: string) => key.replace(/_(one|other)$/, "");

test("registered languages have complete resources, interpolation and plural forms", () => {
  for (const { value } of locales) {
    const instance = createDesktopI18n(value);
    expect(instance.isInitialized).toBe(true);
    for (const namespace of Object.keys(resources.en) as Array<keyof typeof resources.en>) {
      const source = resources.en[namespace];
      const translated = resources[value][namespace];
      expect(new Set(Object.keys(translated).map(baseKey))).toEqual(
        new Set(Object.keys(source).map(baseKey)),
      );
      for (const [key, text] of Object.entries(translated)) {
        const canonical = Object.entries(source).find(
          ([candidate]) => baseKey(candidate) === baseKey(key),
        );
        expect(text.trim(), `${value}:${namespace}:${key}`).not.toBe("");
        expect(placeholders(text), `${value}:${namespace}:${key}`).toEqual(
          placeholders(canonical![1]),
        );
        if (key.endsWith("_other")) {
          for (const category of new Intl.PluralRules(value).resolvedOptions().pluralCategories) {
            expect(Object.hasOwn(translated, `${baseKey(key)}_${category}`)).toBe(true);
          }
        }
      }
    }
  }
});

test("instances keep independent languages and render actual plural counts", async () => {
  const chinese = createDesktopI18n();
  const english = createDesktopI18n("en");
  expect(english.t("schedules:format.everyMinutes", { count: 1 })).toBe("Every 1 minute");
  expect(english.t("schedules:format.everyMinutes", { count: 5 })).toBe("Every 5 minutes");
  expect(chinese.t("schedules:format.everyMinutes", { count: 5 })).toBe("每 5 分钟");
  await english.changeLanguage("zh-CN");
  expect(english.t("navigation:tabPresentations.settings")).toBe("设置");
  expect(chinese.language).toBe("zh-CN");
  english.removeResourceBundle("zh-CN", "settings");
  expect(english.t("settings:appearance.languageSection")).toBe("Language");
});
