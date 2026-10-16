import type { MessageReference } from "./i18n/messages.ts";
import type { BotLibrary } from "@eta/core/shared/bot";

export interface BotConnection {
  url: string;
  token: string;
}
export interface BotState {
  status: "disconnected" | "connected" | "error";
  url?: string;
  message?: string;
  localization?: MessageReference;
  library?: BotLibrary;
  /** Features the connected Bot declares in `/v1/status`; empty for Bots that predate the list. */
  capabilities?: readonly string[];
}
export const isCloudId = (id?: string | null) => id?.startsWith("bot:") ?? false;
export const sameEnvironment = (left: string, right: string) =>
  (!isCloudId(left) && !isCloudId(right)) ||
  (isCloudId(left) && isCloudId(right) && left.split(":")[1] === right.split(":")[1]);
