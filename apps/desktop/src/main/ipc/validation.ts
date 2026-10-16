import { LocalizedError } from "../../shared/i18n/messages.ts";
export function sessionId(value: unknown) {
  if (typeof value !== "string" || !value)
    throw new LocalizedError("errors:validation.invalidSessionId");
  return value;
}
