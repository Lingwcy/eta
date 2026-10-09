import type { DiscordSdk } from "../extensions/discord/sdk.ts";
export function verifyDiscord(implementation: typeof DiscordSdk): Promise<void>;
