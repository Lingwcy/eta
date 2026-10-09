import type { Harness } from "@eta/agent";
import type { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../../protocol.ts";
import type { SubagentSettings } from "../../../shared/subagents.ts";

export type SubagentOptions = {
  invalid: (message: string) => never;
  harness: () => Harness;
  settings: () => Promise<SubagentSettings | undefined>;
  available: (provider: string, modelId: string) => Promise<boolean>;
  clamp: (
    model: { provider: string; modelId: string },
    level: ThinkingLevel,
  ) => ReturnType<typeof clampThinkingLevel>;
  instructions: () => Promise<string>;
  ready?: () => boolean;
  maximumImages?: (model: { provider: string; modelId: string }) => number | undefined;
};
