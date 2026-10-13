import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsRow } from "./settings-section";
import { SandboxPicker } from "@/components/input/sandbox-picker";
import { ModelPicker } from "../input/model-picker";
import type { SandboxMode } from "@eta/core/shared/sandbox";
import { defaultApprovalReviewerMode as DEFAULT_REVIEWER_MODE } from "@eta/core/shared/runtime-settings";
import type { ApprovalReviewer } from "@eta/core/shared/runtime-settings";
import type { ReviewStats } from "@eta/core/service/runtime/review-log";
import type { DesktopLibrary } from "../../../../src/bridge.ts";

function ReviewerSettings({
  library,
  reviewer,
  busy,
  active,
  onChange,
}: {
  library: DesktopLibrary;
  reviewer: ApprovalReviewer | null | undefined;
  busy: boolean;
  active: boolean;
  onChange: (reviewer: ApprovalReviewer | null) => void;
}) {
  const [stats, setStats] = useState<ReviewStats>();
  useEffect(() => {
    if (active) void window.eta.reviewStats().then(setStats, () => setStats(undefined));
  }, [active]);
  const mode = reviewer?.mode ?? DEFAULT_REVIEWER_MODE;
  const selected = reviewer?.model ?? undefined;
  const model = library.models.find(
    (value) => value.provider === selected?.provider && value.id === selected.modelId,
  );
  const choose = (next: ApprovalReviewer["mode"]) => onChange({ ...reviewer, mode: next });
  return (
    <SettingsSection title="越界请求审批">
      <SettingsRow
        title="审批人"
        description={
          reviewer
            ? "代理请求沙盒外的访问时由谁决定。自动审查只决定是否批准，不会扩大权限；拿不准或高风险的请求仍会交给你。"
            : `当前使用默认值（${DEFAULT_REVIEWER_MODE === "auto" ? "自动审查" : "我"}）。代理请求沙盒外的访问时由谁决定。`
        }
      >
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            aria-pressed={mode === "user"}
            disabled={busy}
            onClick={() => choose("user")}
          >
            我
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={mode === "auto"}
            disabled={busy}
            onClick={() => choose("auto")}
          >
            自动审查
          </Button>
          {reviewer && (
            <Button variant="link" size="sm" disabled={busy} onClick={() => onChange(null)}>
              恢复默认
            </Button>
          )}
        </div>
      </SettingsRow>
      {mode === "auto" && (
        <SettingsRow
          title="审查模型"
          description={
            selected && !model
              ? `${selected.provider}/${selected.modelId} 当前不可用，请求会转交给你。`
              : "默认使用发起请求的会话自己的模型。Bot 会话由 Bot 配置文件决定。"
          }
        >
          <div className="max-w-64">
            <ModelPicker
              model={model}
              models={library.models}
              providers={library.providers}
              showThinking={false}
              side="bottom"
              placeholder={
                selected ? `${selected.provider}/${selected.modelId}（不可用）` : undefined
              }
              defaultOption={{
                label: "与会话相同",
                selected: !selected,
                onSelect: () => onChange({ ...reviewer, mode, model: null }),
              }}
              disabled={busy}
              onChange={(value) =>
                onChange({
                  ...reviewer,
                  mode,
                  model: { provider: value.provider, modelId: value.id },
                })
              }
            />
          </div>
        </SettingsRow>
      )}
      {stats && stats.reviews > 0 && (
        <SettingsRow
          title="近期自动审查"
          description={`最近 ${stats.reviews} 次：批准 ${stats.approved}，拒绝 ${stats.denied}，转交 ${stats.escalated + stats.skipped}（其中你批准了 ${stats.escalatedApproved}），平均 ${(stats.averageMs / 1000).toFixed(1)} 秒。`}
        >
          {null}
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

export function PermissionSettings({
  library,
  blockImages,
  busy,
  active,
  onAllowImagesChange,
  sandboxMode,
  onSandboxChange,
  reviewer,
  onReviewerChange,
}: {
  library: DesktopLibrary;
  blockImages: boolean;
  busy: boolean;
  active: boolean;
  onAllowImagesChange: (allowed: boolean) => void;
  sandboxMode: SandboxMode;
  onSandboxChange: (mode: SandboxMode) => void;
  reviewer: ApprovalReviewer | null | undefined;
  onReviewerChange: (reviewer: ApprovalReviewer | null) => void;
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
      <ReviewerSettings
        library={library}
        reviewer={reviewer}
        busy={busy}
        active={active}
        onChange={onReviewerChange}
      />
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
