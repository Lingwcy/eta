import { initReactI18next } from "react-i18next";
import { createDesktopI18n } from "../../../src/shared/i18n/create-i18n.ts";
import { formatLocale, defaultLocale } from "../../../src/shared/i18n/locales.ts";
import type { DesktopBridge } from "../../../src/bridge.ts";

export const i18n = createDesktopI18n();
initReactI18next.init(i18n);
export const t = i18n.t.bind(i18n);
export const currentFormatLocale = () => formatLocale(i18n.language);

/** Main has loaded settings before creating the window; seed the first paint without waiting for the library. */
export async function initializeLocale(bridge: Pick<DesktopBridge, "appInfo">) {
  const locale = await bridge.appInfo().then(
    (info) => info.locale ?? defaultLocale,
    () => defaultLocale,
  );
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}
