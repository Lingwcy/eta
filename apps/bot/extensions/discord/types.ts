import { Schema } from "effect";

const Id = Schema.String.check(Schema.isPattern(/^\d{1,20}$/));
export const DiscordConfigSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  tokenEnv: Schema.NonEmptyString,
  backfillLimit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  ),
  channels: Schema.Array(
    Schema.Struct({
      guildId: Id,
      channelId: Id,
      projectKey: Schema.NonEmptyString,
      triggerPrefix: Schema.optionalKey(Schema.String),
      startAfter: Schema.optionalKey(Id),
    }),
  ),
});
export type DiscordConfig = typeof DiscordConfigSchema.Type;
export const MessageSchema = Schema.Struct({
  id: Id,
  guildId: Id,
  channelId: Id,
  authorId: Id,
  bot: Schema.Boolean,
  content: Schema.String,
  createdAt: Schema.Number,
});
export type DiscordMessage = typeof MessageSchema.Type;
export type IssueState =
  | "queued"
  | "working"
  | "waiting"
  | "failed"
  | "review"
  | "stopped"
  | "closed";
export interface DiscordPort {
  start(handlers: {
    message(message: DiscordMessage): Promise<void>;
    gap(): Promise<void>;
  }): Promise<void>;
  stop(): Promise<void>;
  connected(): boolean;
  ensureThread(source: DiscordMessage, name: string): Promise<string>;
  history(
    channelId: string,
    options: { after?: string; before?: string; limit: number },
  ): Promise<readonly DiscordMessage[]>;
  send(threadId: string, content: string, nonce: string): Promise<string>;
  findDelivery(threadId: string, marker: string): Promise<string | undefined>;
  archive(threadId: string, archived: boolean): Promise<void>;
}

/** A received API rejection is distinguishable from a network failure with an unknown outcome. */
export class DeliveryError extends Error {
  constructor(readonly retryable: boolean) {
    super("Discord rejected the delivery.");
  }
}
