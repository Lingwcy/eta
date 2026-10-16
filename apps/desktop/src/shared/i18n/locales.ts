export const locales = [
  { value: "zh-CN", label: "简体中文", formatLocale: "zh-CN" },
  { value: "en", label: "English", formatLocale: "en-US" },
] as const;

export type AppLocale = (typeof locales)[number]["value"];
export const defaultLocale: AppLocale = "zh-CN";
export const localeValues = locales.map((locale) => locale.value);

export function formatLocale(locale: string) {
  return locales.find((entry) => entry.value === locale)?.formatLocale ?? defaultLocale;
}
