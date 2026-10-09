import { Schema } from "effect";
import { builtinToolNames } from "../tools.ts";
import { SubagentSettingsSchema } from "./subagent-schema.ts";

export const TitleModelSchema = Schema.NullOr(
  Schema.Struct({ provider: Schema.NonEmptyString, modelId: Schema.NonEmptyString }),
);

export const RuntimeSettingsSchema = Schema.Struct({
  subagents: Schema.optionalKey(SubagentSettingsSchema),
  defaultProvider: Schema.optionalKey(Schema.NonEmptyString),
  defaultModel: Schema.optionalKey(Schema.NonEmptyString),
  titleModel: Schema.optionalKey(TitleModelSchema),
  defaultThinkingLevel: Schema.Literals([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]),
  disabledTools: Schema.optionalKey(Schema.Array(Schema.Literals(builtinToolNames))),
  skillsEnabled: Schema.optionalKey(Schema.Boolean),
  skillDirectories: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  disabledSkills: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  blockImages: Schema.optionalKey(Schema.Boolean),
});

export type RuntimeSettings = typeof RuntimeSettingsSchema.Type;

/** Project host settings onto the runtime contract, excluding application-specific preferences. */
export const runtimeSettings = Schema.decodeUnknownSync(RuntimeSettingsSchema);
