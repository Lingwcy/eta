import { Schema } from "effect";

export const BotConnectionSchema = Schema.Struct({
  url: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
});
