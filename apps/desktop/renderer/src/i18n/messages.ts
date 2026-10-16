import { DesktopCommandError } from "../../../src/command-reply.ts";
import { i18n } from "./index";
import { resources } from "../../../src/shared/i18n/resources.ts";

import {
  LocalizedError,
  type Message,
  type MessageKey,
} from "../../../src/shared/i18n/messages.ts";
export {
  LocalizedError,
  localizedMessage,
  type Message,
  type MessageKey,
} from "../../../src/shared/i18n/messages.ts";

export function describeError(error: unknown, fallback?: Message): Message {
  if (error instanceof LocalizedError) return error.reference;
  if (error instanceof DesktopCommandError && error.localization) return error.localization;
  const diagnostic = error instanceof Error ? error.message : String(error);
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && Object.hasOwn(resources.en.errors, code)) {
      const key = `errors:${code}` as MessageKey;
      return { key, diagnostic };
    }
  }
  return error instanceof Error ? diagnostic : (fallback ?? diagnostic);
}

export function renderMessage(message?: Message | null): string | undefined {
  if (message == null) return undefined;
  if (typeof message === "string") return message;
  const text = i18n.t(message.key, { ...message.values, defaultValue: message.key });
  return message.diagnostic ? `${text}\n${message.diagnostic}` : text;
}
