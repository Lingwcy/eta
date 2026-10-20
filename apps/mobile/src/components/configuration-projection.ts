import type { Configuration } from "../bot/contracts.ts";

/**
 * Only the fields this sheet changed are written; everything else follows the live configuration,
 * so a change made elsewhere while the sheet was open is not silently reverted.
 */
export function applySelection(
  opened: Configuration,
  selected: Configuration,
  latest: Configuration,
): Configuration {
  const modelChanged = selected.provider !== opened.provider || selected.modelId !== opened.modelId;
  const thinkingChanged = selected.thinkingLevel !== opened.thinkingLevel;
  const sandboxChanged = selected.sandboxMode !== opened.sandboxMode;
  return {
    ...latest,
    ...(modelChanged ? { provider: selected.provider, modelId: selected.modelId } : {}),
    // A thinking level belongs to the chosen model, so it moves with the model too.
    ...(modelChanged || thinkingChanged ? { thinkingLevel: selected.thinkingLevel } : {}),
    ...(sandboxChanged ? { sandboxMode: selected.sandboxMode } : {}),
  };
}
