import type { ThinkingLevel } from "../../../../src/agent/protocol.ts";
import type { InputModel } from "./types";

export const thinkingOptions = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" },
] satisfies { value: ThinkingLevel; label: string }[];

/** Matches the provider's clamp policy using only the capabilities sent across the bridge. */
export function resolveThinkingLevel(model: InputModel | undefined, level: ThinkingLevel) {
  const available = thinkingOptions.filter((option) =>
    model?.thinkingLevels.includes(option.value),
  );
  const requested = thinkingOptions.findIndex((option) => option.value === level);
  return (
    available.find((option) => thinkingOptions.indexOf(option) >= requested)?.value ??
    available.at(-1)?.value ??
    "off"
  );
}
