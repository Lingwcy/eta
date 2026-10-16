import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsSection, SettingsRow } from "./settings-section";
import { SandboxPicker } from "@/components/input/sandbox-picker";
import { ModelPicker } from "../input/model-picker";
import type { SandboxMode } from "@eta/core/shared/sandbox";
import {
  defaultAgentMode,
  defaultApprovalReviewerMode as DEFAULT_REVIEWER_MODE,
} from "@eta/core/shared/runtime-settings";
import type { AgentMode, ApprovalReviewer } from "@eta/core/shared/runtime-settings";
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
  useTranslation();
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
    <SettingsSection title={t("settings:permissionSettings.approvalForAccessOutsideTheSandbox")}>
      <SettingsRow
        title={t("settings:permissionSettings.approver")}
        description={
          reviewer
            ? t("settings:permissionSettings.whoDecidesWhenTheAgentRequestsAccess")
            : t("settings:permissionSettings.usingTheDefaultWhoDecidesWhenThe", {
                value1:
                  DEFAULT_REVIEWER_MODE === "auto"
                    ? t("settings:permissionSettings.automaticReview")
                    : t("settings:permissionSettings.me"),
              })
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
            {t("settings:permissionSettings.me")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={mode === "auto"}
            disabled={busy}
            onClick={() => choose("auto")}
          >
            {t("settings:permissionSettings.automaticReview")}
          </Button>
          {reviewer && (
            <Button variant="link" size="sm" disabled={busy} onClick={() => onChange(null)}>
              {t("settings:permissionSettings.resetToDefault")}
            </Button>
          )}
        </div>
      </SettingsRow>
      {mode === "auto" && (
        <SettingsRow
          title={t("settings:permissionSettings.reviewModel")}
          description={
            selected && !model
              ? t("settings:permissionSettings.isUnavailableRequestsWillGoToYou", {
                  provider: selected.provider,
                  modelId: selected.modelId,
                })
              : t("settings:permissionSettings.usesTheRequestingChatSModelBy")
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
                selected
                  ? t("settings:permissionSettings.unavailable", {
                      provider: selected.provider,
                      modelId: selected.modelId,
                    })
                  : undefined
              }
              defaultOption={{
                label: t("settings:permissionSettings.sameAsChat"),
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
          title={t("settings:permissionSettings.recentAutomaticReviews")}
          description={t("settings:permissionSettings.lastReviewsApprovedDeniedReferredToYou", {
            reviews: stats.reviews,
            approved: stats.approved,
            denied: stats.denied,
            value4: stats.escalated + stats.skipped,
            escalatedApproved: stats.escalatedApproved,
            value6: (stats.averageMs / 1000).toFixed(1),
          })}
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
  agentMode,
  onAgentModeChange,
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
  agentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
}) {
  useTranslation();
  return (
    <>
      <SettingsSection title={t("settings:permissionSettings.agentMode")}>
        <SettingsRow
          title={t("settings:permissionSettings.localToolCallingMode")}
          description={t("settings:permissionSettings.codeModeCombinesEnabledToolsUsingJavascript")}
        >
          <SegmentedControl
            aria-label={t("settings:permissionSettings.localToolCallingMode")}
            value={agentMode}
            options={[
              { value: "codemode", label: "Code mode" },
              { value: "standard", label: t("settings:permissionSettings.standardMode") },
            ]}
            disabled={busy}
            onValueChange={onAgentModeChange}
          />
        </SettingsRow>
        {library.bot?.status === "connected" && (
          <SettingsRow
            title={t("settings:permissionSettings.botToolCallingMode")}
            description={t("settings:permissionSettings.determinedByTheBotRuntimeConfiguration")}
          >
            <span className="text-xs text-neutral-500">
              {library.bot.capabilities?.includes("agent-mode")
                ? (library.bot.library?.settings.agentMode ?? defaultAgentMode) === "codemode"
                  ? "Code mode"
                  : t("settings:permissionSettings.standardMode")
                : t("settings:permissionSettings.thisBotVersionDoesNotSupportMode")}
            </span>
          </SettingsRow>
        )}
      </SettingsSection>
      <SettingsSection title={t("settings:permissionSettings.agentSandbox")}>
        <SettingsRow
          title={t("settings:permissionSettings.defaultPolicyForNewChats")}
          description={t("settings:permissionSettings.onlyAffectsLocalChatsCreatedLaterChange")}
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
      {library.bot?.status === "connected" && (
        <SettingsSection
          title={t("settings:permissionSettings.botApprovalForAccessOutsideTheSandbox")}
        >
          <SettingsRow
            title={t("settings:permissionSettings.approver")}
            description={t(
              "settings:permissionSettings.determinedByRuntimeApprovalreviewerInTheBot",
            )}
          >
            <span className="text-xs text-neutral-500">
              {library.bot.capabilities?.includes("approval-review")
                ? (library.bot.library?.settings.approvalReviewer?.mode ??
                    DEFAULT_REVIEWER_MODE) === "auto"
                  ? t("settings:permissionSettings.automaticReview")
                  : t("settings:permissionSettings.me")
                : t("settings:permissionSettings.thisBotVersionDoesNotSupportAutomatic")}
            </span>
          </SettingsRow>
        </SettingsSection>
      )}
      <SettingsSection title={t("settings:permissionSettings.imageAccess")}>
        <SettingsRow
          title={t("settings:permissionSettings.allowTheModelToReadImages")}
          description={t("settings:permissionSettings.whenOffOnlyTextPlaceholdersAreSent")}
        >
          <Button
            variant="outline"
            size="sm"
            aria-pressed={!blockImages}
            disabled={busy}
            onClick={() => onAllowImagesChange(blockImages)}
          >
            {blockImages
              ? t("settings:permissionSettings.off")
              : t("settings:permissionSettings.on")}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
