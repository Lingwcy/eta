import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsRow } from "./settings-section";

export function PermissionSettings({
  blockImages,
  busy,
  onAllowImagesChange,
}: {
  blockImages: boolean;
  busy: boolean;
  onAllowImagesChange: (allowed: boolean) => void;
}) {
  return (
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
  );
}
