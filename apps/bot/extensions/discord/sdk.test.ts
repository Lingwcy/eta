import { test } from "vite-plus/test";
import { DiscordSdk } from "./sdk.ts";
import { verifyDiscord } from "../../scripts/verify-discord.mjs";

test("real SDK Gateway and REST preserve thread identity, reply ownership and delivery controls", async () => {
  await verifyDiscord(DiscordSdk);
}, 15000);
