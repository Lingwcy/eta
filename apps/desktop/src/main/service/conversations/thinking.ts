import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import type { Conversation } from "@eta/agent";

/** Repair idle configuration after legacy writes or a refreshed model catalog. */
export async function normalizeThinkingLevel(conversation: Conversation, models: Models) {
  const agent = await conversation.agent(BACKGROUND_CONTEXT);
  const model = agent.model && models.getModel(agent.model.provider, agent.model.modelId);
  if (!model) return;
  const level = clampThinkingLevel(model, agent.thinkingLevel);
  if (level !== agent.thinkingLevel)
    await conversation.configure(
      { thinkingLevel: level === "off" ? null : level },
      BACKGROUND_CONTEXT,
    );
}
