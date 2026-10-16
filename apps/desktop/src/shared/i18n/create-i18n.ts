import { createInstance } from "i18next";
import { defaultLocale, localeValues, type AppLocale } from "./locales.ts";
import { resources } from "./resources.ts";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    keySeparator: false;
    returnNull: false;
    resources: (typeof resources)["en"];
  }
}

/** Static resources initialize synchronously; each host owns its language. */
export function createDesktopI18n(locale: AppLocale = defaultLocale) {
  const instance = createInstance();
  void instance.init({
    resources: structuredClone(resources),
    lng: locale,
    fallbackLng: "en",
    supportedLngs: localeValues,
    load: "currentOnly",
    defaultNS: "common",
    ns: Object.keys(resources.en),
    keySeparator: false,
    initAsync: false,
    returnNull: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}
