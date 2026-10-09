import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Schema } from "effect";
import { RuntimeSettingsSchema } from "@eta/core";
import { DiscordConfigSchema } from "../extensions/discord/types.ts";

export const BotConfigSchema = Schema.Struct({
  dataRoot: Schema.NonEmptyString,
  home: Schema.optionalKey(Schema.NonEmptyString),
  host: Schema.optionalKey(Schema.NonEmptyString),
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  adminToken: Schema.NonEmptyString,
  maxConcurrent: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  ),
  shutdownGraceMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
  ),
  projects: Schema.Array(
    Schema.Struct({
      key: Schema.NonEmptyString,
      rootPath: Schema.NonEmptyString,
      name: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),
  runtime: RuntimeSettingsSchema,
  credentials: Schema.optionalKey(Schema.Record(Schema.String, Schema.NonEmptyString)),
  discord: Schema.optionalKey(DiscordConfigSchema),
});
export type BotConfig = typeof BotConfigSchema.Type;

export async function loadBotConfig(path: string) {
  const root = dirname(resolve(path));
  let config: BotConfig;
  try {
    config = Schema.decodeUnknownSync(BotConfigSchema, { onExcessProperty: "error" })(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch {
    throw new Error(
      "Bot configuration is unreadable or invalid; check its fields and JSON format.",
    );
  }
  if (new Set(config.projects.map(({ key }) => key)).size !== config.projects.length)
    throw new Error("Bot project keys must be unique.");
  if (
    config.discord &&
    new Set(config.discord.channels.map(({ channelId }) => channelId)).size !==
      config.discord.channels.length
  )
    throw new Error("Discord channel mappings must be unique.");
  const dataRoot = resolve(root, config.dataRoot);
  return {
    ...config,
    dataRoot,
    home: config.home === undefined ? resolve(dataRoot, "home") : resolve(root, config.home),
    projects: config.projects.map((project) => ({
      ...project,
      rootPath: resolve(root, project.rootPath),
    })),
  };
}
