import { Schema } from "effect";
import { RuntimeSettingsSchema } from "@eta/core/shared/runtime-settings";
import { agentThinkingVariants } from "../appearance.ts";

export const SettingsSchema = Schema.Struct({
  ...RuntimeSettingsSchema.fields,
  agentThinkingVariant: Schema.optionalKey(Schema.Literals(agentThinkingVariants)),
  activeThreadId: Schema.optionalKey(Schema.NonEmptyString),
  autoCheckUpdates: Schema.optionalKey(Schema.Boolean),
});
