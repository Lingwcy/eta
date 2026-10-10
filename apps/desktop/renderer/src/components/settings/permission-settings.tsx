import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsRow } from "./settings-section";
import { SandboxPicker } from "@/components/input/sandbox-picker";
import type { SandboxMode } from "@eta/core/shared/sandbox";

export function PermissionSettings({
  blockImages,
  busy,
  onAllowImagesChange,
  sandboxMode,
  onSandboxChange,
}: {
  blockImages: boolean;
  busy: boolean;
  onAllowImagesChange: (allowed: boolean) => void;
  sandboxMode: SandboxMode;
  onSandboxChange: (mode: SandboxMode) => void;
}) {
  return (
    <>
      <SettingsSection title="代理沙盒">
        <SettingsRow
          title="新会话默认策略"
          description="仅影响之后创建的本机会话。已有会话可在输入框切换，需先停止当前任务和子智能体。"
        >
          <SandboxPicker
            mode={sandboxMode}
            disabled={busy}
            side="bottom"
            onChange={onSandboxChange}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="图片读取">
        <SettingsRow
          title="允许模型读取图片"
          description="关闭后仅发送文字占位符，图片仍保留在会话中。"
        >
          <Button
            variant="outline"
            size="sm"
            aria-pressed={!blockImages}
            disabled={busy}
            onClick={() => onAllowImagesChange(blockImages)}
          >
            {blockImages ? "已关闭" : "已开启"}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
