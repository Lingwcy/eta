import type { ToolRegistration, Harness, Tx, ConversationId } from "@eta/agent";
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
  excludedTools?: readonly ToolRegistration[];
  /** Host capabilities that cannot be delegated, such as the shared local desktop. */
  orchestratorTools?: readonly ToolRegistration[];
  maximumImages?: (model: { provider: string; modelId: string }) => number | undefined;
  inheritExecution?: (tx: Tx, parent: ConversationId, child: ConversationId) => Promise<void>;
};
