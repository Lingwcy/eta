import { Schema } from "effect";
import { RuntimeSettingsSchema } from "@eta/core/shared/runtime-settings";
import { agentThinkingVariants } from "../appearance.ts";
import { localeValues } from "./i18n/locales.ts";

export const LocaleSchema = Schema.Literals(localeValues);

export const SettingsSchema = Schema.Struct({
  ...RuntimeSettingsSchema.fields,
  locale: Schema.optionalKey(LocaleSchema),
  agentThinkingVariant: Schema.optionalKey(Schema.Literals(agentThinkingVariants)),
  activeThreadId: Schema.optionalKey(Schema.NonEmptyString),
  backgroundOnClose: Schema.optionalKey(Schema.Boolean),
  autoCheckUpdates: Schema.optionalKey(Schema.Boolean),
});
