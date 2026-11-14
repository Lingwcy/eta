import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  DEFAULT_LOCALE,
  getLocale,
  getMessages,
  localeLabels,
  parseLocale,
  registerLocalePersistence,
  setLocale,
  subscribeLocale,
  SUPPORTED_LOCALES,
} from "./index.ts";
import { catalog } from "./messages.ts";

afterEach(() => {
  registerLocalePersistence(async () => {});
  setLocale(DEFAULT_LOCALE, false);
});

describe("i18n store and message catalogs", () => {
  test("defaults to English and parses only supported locale codes", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(getLocale()).toBe("en");
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh", "ja"]);
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale("zh")).toBe("zh");
    expect(parseLocale("ja")).toBe("ja");
    expect(parseLocale("fr")).toBeUndefined();
    expect(parseLocale(null)).toBeUndefined();
    expect(parseLocale(123)).toBeUndefined();
  });

  test("setLocale notifies subscribers and invokes persistence only when persist is true", () => {
    const writer = vi.fn(async () => {});
    const listener = vi.fn();
    registerLocalePersistence(writer);
    const unsubscribe = subscribeLocale(listener);

    setLocale("ja", false);
    expect(getLocale()).toBe("ja");
    expect(getMessages().onboarding.heroTitle).toBe("どこでも、即座に開発");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(writer).not.toHaveBeenCalled();

    setLocale("zh");
    expect(getLocale()).toBe("zh");
    expect(getMessages().onboarding.heroTitle).toBe("随身编码，随时接管");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(writer).toHaveBeenCalledWith("zh");

    setLocale("zh");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  test("en, zh, and ja catalogs contain identical structure and non-empty labels", () => {
    const collectKeys = (obj: Record<string, unknown>, prefix = ""): string[] => {
      const keys: string[] = [];
      for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "object" && value !== null) {
          keys.push(...collectKeys(value as Record<string, unknown>, path));
        } else {
          keys.push(path);
        }
      }
      return keys.sort();
    };

    const enKeys = collectKeys(catalog.en as unknown as Record<string, unknown>);
    expect(collectKeys(catalog.zh as unknown as Record<string, unknown>)).toEqual(enKeys);
    expect(collectKeys(catalog.ja as unknown as Record<string, unknown>)).toEqual(enKeys);

    for (const locale of SUPPORTED_LOCALES) {
      expect(localeLabels[locale].native.length).toBeGreaterThan(0);
      expect(localeLabels[locale].short.length).toBeGreaterThan(0);
      const msgs = catalog[locale];
      expect(msgs.onboarding.startAction.length).toBeGreaterThan(0);
      expect(msgs.settings.syncedSummary(2, 3)).toContain("2");
      expect(msgs.settings.syncedSummary(2, 3)).toContain("3");
    }
  });
});
