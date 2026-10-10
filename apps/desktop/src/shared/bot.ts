import type { BotLibrary } from "@eta/core/shared/bot";

export interface BotConnection {
  url: string;
  token: string;
}
export interface BotState {
  status: "disconnected" | "connected" | "error";
  url?: string;
  message?: string;
  library?: BotLibrary;
}
export const isCloudId = (id?: string | null) => id?.startsWith("bot:") ?? false;
export const sameEnvironment = (left: string, right: string) =>
  (!isCloudId(left) && !isCloudId(right)) ||
  (isCloudId(left) && isCloudId(right) && left.split(":")[1] === right.split(":")[1]);
