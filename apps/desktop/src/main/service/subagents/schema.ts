import { Schema } from "effect";

export const SubagentPresetSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  instructions: Schema.String,
  canDelegate: Schema.optionalKey(Schema.Boolean),
  thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  models: Schema.Array(
    Schema.Struct({ provider: Schema.NonEmptyString, modelId: Schema.NonEmptyString }),
  ),
});
export const SubagentSettingsSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  mode: Schema.Literals(["opportunistic", "orchestrator"]),
  maxDepth: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 10 })),
  maxConcurrent: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 32 })),
  presets: Schema.Array(SubagentPresetSchema),
  allowedModels: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ provider: Schema.NonEmptyString, modelId: Schema.NonEmptyString }),
    ),
  ),
});
export const SubagentCommandSchema = Schema.Struct({
  images: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("image"),
        data: Schema.NonEmptyString,
        mimeType: Schema.NonEmptyString,
        name: Schema.optionalKey(Schema.String),
        note: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  action: Schema.Literals([
    "spawn",
    "send",
    "pause",
    "resume",
    "stop",
    "list",
    "wait",
    "update",
    "output",
  ]),
  canDelegate: Schema.optionalKey(Schema.Boolean),
  wait: Schema.optionalKey(Schema.Boolean),
  timeoutMs: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 3600000 })),
  ),
  offset: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 32000 })),
  ),
  path: Schema.optionalKey(Schema.NonEmptyString),
  name: Schema.optionalKey(Schema.NonEmptyString),
  parent: Schema.optionalKey(Schema.NonEmptyString),
  message: Schema.optionalKey(Schema.String),
  preset: Schema.optionalKey(Schema.NonEmptyString),
  fork: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(
    Schema.Struct({ provider: Schema.NonEmptyString, modelId: Schema.NonEmptyString }),
  ),
  thinkingLevel: Schema.optionalKey(
    Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  ),
});
