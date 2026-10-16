import { t } from "@/i18n";
import type { ThinkingLevel } from "@eta/core/agent/protocol";
import type { InputModel } from "./types";

export const thinkingOptions = () =>
  [
    { value: "off", label: t("chat:modelThinking.off") },
    { value: "minimal", label: t("chat:modelThinking.minimal") },
    { value: "low", label: t("chat:modelThinking.low") },
    { value: "medium", label: t("chat:modelThinking.medium") },
    { value: "high", label: t("chat:modelThinking.high") },
    { value: "xhigh", label: t("chat:modelThinking.extraHigh") },
    { value: "max", label: t("chat:modelThinking.maximum") },
  ] satisfies { value: ThinkingLevel; label: string }[];

/** Matches the provider's clamp policy using only the capabilities sent across the bridge. */
export function resolveThinkingLevel(model: InputModel | undefined, level: ThinkingLevel) {
  const options = thinkingOptions();
  const available = options.filter((option) => model?.thinkingLevels.includes(option.value));
  const requested = options.findIndex((option) => option.value === level);
  return (
    available.find((option) => options.indexOf(option) >= requested)?.value ??
    available.at(-1)?.value ??
    "off"
  );
}
