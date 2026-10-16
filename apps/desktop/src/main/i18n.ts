import { createDesktopI18n } from "../shared/i18n/create-i18n.ts";
import { LocalizedError } from "../shared/i18n/messages.ts";

export const mainI18n = createDesktopI18n();
export const t = mainI18n.t.bind(mainI18n);

export function errorMessage(error: unknown) {
  return error instanceof LocalizedError
    ? t(error.reference.key, { ...error.reference.values, defaultValue: error.message })
    : error instanceof Error
      ? error.message
      : String(error);
}
