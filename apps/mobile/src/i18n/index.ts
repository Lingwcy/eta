import { useSyncExternalStore } from "react";
import { catalog, DEFAULT_LOCALE, localeLabels, SUPPORTED_LOCALES } from "./messages.ts";
import type { AppMessages, Locale } from "./messages.ts";

export { DEFAULT_LOCALE, localeLabels, SUPPORTED_LOCALES };
export type { AppMessages, Locale };

let currentLocale: Locale = DEFAULT_LOCALE;
let persistWriter: ((locale: Locale) => Promise<void>) | undefined;
const listeners = new Set<() => void>();

export function parseLocale(value: unknown): Locale | undefined {
  if (value === "en" || value === "zh" || value === "ja") return value;
  return undefined;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function getMessages(locale: Locale = currentLocale): AppMessages {
  return catalog[locale];
}

export function registerLocalePersistence(writer: (locale: Locale) => Promise<void>) {
  persistWriter = writer;
}

/** Updates active app locale and notifies subscribers, persisting asynchronously when configured. */
export function setLocale(next: Locale, persist = true) {
  if (next === currentLocale) return;
  currentLocale = next;
  for (const listener of listeners) listener();
  if (persist && persistWriter) {
    void persistWriter(next).catch(() => {});
  }
}

export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook returning current locale, switcher, and typed message catalog. */
export function useI18n() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return {
    locale,
    setLocale,
    m: catalog[locale],
  };
}
