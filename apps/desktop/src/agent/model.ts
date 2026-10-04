import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentModel } from "./protocol.ts";

/** Carries model capabilities across the desktop bridge without provider runtime handles. */
export function toAgentModel(model: Model<Api>): AgentModel {
  return {
    id: model.id,
    provider: model.provider,
    name: model.name,
    contextWindow: model.contextWindow,
    input: model.input,
    inputLimits: model.inputLimits,
    thinkingLevels: getSupportedThinkingLevels(model),
  };
}
