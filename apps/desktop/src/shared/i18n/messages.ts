import { createDesktopI18n } from "./create-i18n.ts";
import type { resources } from "./resources.ts";

const diagnostics = createDesktopI18n();

export type MessageKey = Extract<
  import("i18next").ParseKeys<readonly (keyof typeof resources.en)[]>,
  `${string}:${string}`
>;
export interface MessageReference {
  key: MessageKey;
  values?: Record<string, string | number>;
  diagnostic?: string;
}
export type Message = string | MessageReference;

export function localizedMessage(
  key: MessageKey,
  values?: MessageReference["values"],
): MessageReference {
  return { key, ...(values ? { values } : {}) };
}

/** Keep the identity until display so pending errors follow language changes. */
export class LocalizedError extends Error {
  readonly reference: MessageReference;
  constructor(key: MessageKey, values?: MessageReference["values"]) {
    super(diagnostics.t(key, { ...values, defaultValue: key }));
    this.reference = localizedMessage(key, values);
  }
}
