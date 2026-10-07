/** Shared by persisted preferences and the renderer's thinking indicators. */
export const agentThinkingVariants = ["wave", "spin", "stars", "infinity"] as const;
export type AgentThinkingVariant = (typeof agentThinkingVariants)[number];
