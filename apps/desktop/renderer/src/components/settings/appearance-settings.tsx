import { AgentThinking } from "@/components/agent-thinking";
import type { AgentThinkingVariant } from "../../../../src/appearance.ts";
import { Select } from "@/components/ui/select";
import { SettingsRow, SettingsSection } from "./settings-section";

const variants = [
  { value: "wave", label: "点阵波浪" },
  { value: "spin", label: "点阵旋转" },
  { value: "stars", label: "星光闪烁" },
  { value: "infinity", label: "无限循环" },
] satisfies { value: AgentThinkingVariant; label: string }[];

export function AppearanceSettings({
  variant,
  active,
  busy,
  onVariantChange,
}: {
  variant: AgentThinkingVariant;
  active: boolean;
  busy: boolean;
  onVariantChange: (variant: AgentThinkingVariant) => void;
}) {
  return (
    <SettingsSection title="思考与响应">
      <SettingsRow title="动画样式" description="用于思考和等待响应，选择后自动保存。">
        <Select
          value={variant}
          options={variants}
          label="思考动画样式"
          panelTitle="动画样式"
          size="compact"
          variant="menu"
          disabled={busy}
          onValueChange={onVariantChange}
        />
      </SettingsRow>
      <div className="flex items-center gap-5 py-3" aria-label="动画预览">
        <span className="text-xs text-neutral-400">预览</span>
        <AgentThinking key={variant} variant={variant} label="正在思考" active={active} />
      </div>
    </SettingsSection>
  );
}
