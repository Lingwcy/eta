import { Schema } from "effect";
import { SubagentSettingsSchema } from "./subagent-schema.ts";
import { agentThinkingVariants } from "../appearance.ts";
import { builtinToolNames } from "../tools.ts";

export const TitleModelSchema = Schema.NullOr(
  Schema.Struct({ provider: Schema.NonEmptyString, modelId: Schema.NonEmptyString }),
);

export const SettingsSchema = Schema.Struct({
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
  agentThinkingVariant: Schema.optionalKey(Schema.Literals(agentThinkingVariants)),
  activeThreadId: Schema.optionalKey(Schema.NonEmptyString),
  autoCheckUpdates: Schema.optionalKey(Schema.Boolean),
});
