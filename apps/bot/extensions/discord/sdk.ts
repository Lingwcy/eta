import { ChannelType, Client, DiscordAPIError, Events, GatewayIntentBits } from "discord.js";
import type { Message } from "discord.js";
import type { DiscordMessage, DiscordPort } from "./types.ts";
import { DeliveryError } from "./types.ts";

function messageValue(message: Message): DiscordMessage {
  if (!message.guildId) throw new Error("Discord guild message required.");
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author.id,
    bot: message.author.bot,
    content: message.content,
    createdAt: message.createdTimestamp,
  };
}

/** Gateway owns reception/reconnect; the SDK's REST manager owns API rate limits. */
export class DiscordSdk implements DiscordPort {
  private readonly client: Client;
  private stopping = false;
  constructor(
    private readonly tokenEnv: string,
    options: { api?: string } = {},
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      rest: { timeout: 10000, retries: 2, ...options },
    });
  }
  connected() {
    return this.client.isReady() && !this.stopping;
  }
  async start(handlers: Parameters<DiscordPort["start"]>[0]) {
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error("Discord token environment variable is missing.");
    this.stopping = false;
    this.client.on(Events.MessageCreate, (message) => {
      if (message.guildId && !this.stopping)
        void handlers.message(messageValue(message)).catch(() => {});
    });
    this.client.on(Events.ShardReady, () => {
      if (!this.stopping) void handlers.gap().catch(() => {});
    });
    this.client.on(Events.ShardResume, () => {
      if (!this.stopping) void handlers.gap().catch(() => {});
    });
    // EventEmitter's special error event must not take down unrelated HTTP work.
    this.client.on(Events.Error, () => {});
    try {
      await this.client.login(token);
    } catch {
      await this.stop();
      throw new Error("Discord connection failed; check the token and Gateway intents.");
    }
  }
  async stop() {
    this.stopping = true;
    this.client.removeAllListeners();
    await this.client.destroy();
  }
  private async messages(channelId: string) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("messages" in channel))
      throw new Error("Discord channel is unavailable.");
    return channel.messages;
  }
  async ensureThread(source: DiscordMessage, name: string) {
    // A thread created from a message has that message's ID, making crash reconciliation deterministic.
    const existing = await this.client.channels.fetch(source.id).catch((error: unknown) => {
      if (error instanceof DiscordAPIError && error.code === 10003) return null;
      throw error;
    });
    if (existing) {
      if (
        !existing.isThread() ||
        existing.parentId !== source.channelId ||
        existing.guildId !== source.guildId
      )
        throw new Error("Discord source thread does not match its channel.");
      return existing.id;
    }
    const channel = await this.client.channels.fetch(source.channelId);
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== source.guildId)
      throw new Error("A configured Discord text channel is required.");
    const message = await channel.messages.fetch(source.id);
    return (await message.startThread({ name: name.slice(0, 100), autoArchiveDuration: 1440 })).id;
  }
  async history(channelId: string, options: Parameters<DiscordPort["history"]>[1]) {
    const messages = await (
      await this.messages(channelId)
    ).fetch({ ...options, limit: Math.min(100, options.limit) });
    return [...messages.values()].filter((message) => message.guildId !== null).map(messageValue);
  }
  async send(threadId: string, content: string, nonce: string) {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isSendable()) throw new DeliveryError(false);
    try {
      return (
        await channel.send({
          content,
          nonce,
          enforceNonce: true,
          allowedMentions: { parse: [], repliedUser: false },
        })
      ).id;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.status < 500)
        throw new DeliveryError(error.status === 429);
      throw new Error("Discord delivery outcome is uncertain.");
    }
  }
  async findDelivery(threadId: string, marker: string) {
    const messages = await (await this.messages(threadId)).fetch({ limit: 100 });
    return messages.find(
      (message) => message.author.id === this.client.user?.id && message.content.includes(marker),
    )?.id;
  }
  async archive(threadId: string, archived: boolean) {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isThread()) throw new Error("Discord thread is unavailable.");
    await channel.setArchived(archived);
  }
}
