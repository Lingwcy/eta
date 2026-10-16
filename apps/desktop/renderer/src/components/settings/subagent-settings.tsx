import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { defaultModel } from "@/desktop/selectors";
import type { ModelSelection } from "@/desktop/selectors";
import { useEffect, useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { defaultSubagentSettings } from "@eta/core/shared/subagents";
import type { SubagentSettings as Policy } from "@eta/core/shared/subagents";
import { SettingsSection, SettingsRow } from "./settings-section";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ModelPicker } from "../input/model-picker";
import { thinkingOptions } from "../input/model-thinking";
import { ToastNotice } from "@/components/ui/toast";
import type { ThinkingLevel } from "@eta/core/agent/protocol";

type Preset = Policy["presets"][number];

function SettingsNumber({
  value,
  minimum,
  maximum,
  label,
  disabled,
  onChange,
}: {
  value: number;
  minimum: number;
  maximum: number;
  label: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (draft.trim() && Number.isInteger(next) && next >= minimum && next <= maximum) {
      if (next !== value) onChange(next);
    } else setDraft(String(value));
  };
  return (
    <div className="w-20">
      <Input
        variant="compact"
        type="number"
        min={minimum}
        max={maximum}
        step={1}
        aria-label={label}
        value={draft}
        onValueChange={setDraft}
        disabled={disabled}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}

export function SubagentSettings({
  library,
  mainModel: activeModel,
  busy,
  onChange,
}: {
  library: DesktopLibrary;
  mainModel?: ModelSelection;
  busy: boolean;
  onChange: (subagents: Policy) => Promise<void>;
}) {
  useTranslation();
  const policy = library.settings.subagents ?? defaultSubagentSettings;
  const enabled = policy.enabled !== false;
  const fallback = defaultModel(library);
  const mainModel =
    activeModel ?? (fallback && { provider: fallback.provider, modelId: fallback.id });
  const enabledModels = policy.allowedModels?.length
    ? policy.allowedModels
    : mainModel
      ? [mainModel]
      : [];
  const enabledCatalog = library.models.filter((model) =>
    enabledModels.some(
      (enabled) => enabled.provider === model.provider && enabled.modelId === model.id,
    ),
  );
  const modelLabel = (models: Preset["models"], empty: string) =>
    models.length === 1
      ? (library.models.find(
          (model) => model.provider === models[0]!.provider && model.id === models[0]!.modelId,
        )?.name ?? models[0]!.modelId)
      : models.length
        ? t("settings:subagentSettings.models", { count: models.length })
        : empty;
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [canDelegate, setCanDelegate] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const [models, setModels] = useState<Preset["models"]>([]);
  const [error, setError] = useState<Message>();
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const configurationLocked = locked || !enabled;
  const save = async (next: Policy) => {
    setSaving(true);
    setError(undefined);
    try {
      await onChange(next);
    } catch (error) {
      setError(describeError(error, localizedMessage("settings:subagentSettings.saveFailed")));
      throw error;
    } finally {
      setSaving(false);
    }
  };
  const edit = (preset?: Preset) => {
    setEditing(preset?.name ?? "");
    setName(preset?.name ?? "");
    setInstructions(preset?.instructions ?? "");
    setCanDelegate(preset?.canDelegate ?? false);
    setThinkingLevel(preset?.thinkingLevel ?? "off");
    setModels(preset?.models ?? []);
    setError(undefined);
  };
  return (
    <>
      <ToastNotice message={error} />
      <SettingsSection title={t("settings:subagentSettings.preferences")}>
        <SettingsRow
          title={t("settings:subagentSettings.enableSubagents")}
          description={t("settings:subagentSettings.allowAgentsToDelegateTasksTurningThis")}
        >
          <Switch
            aria-label={t("settings:subagentSettings.enableSubagents")}
            checked={enabled}
            disabled={locked}
            onCheckedChange={(enabled) => void save({ ...policy, enabled }).catch(() => {})}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings:subagentSettings.delegationSettings")}>
        <SettingsRow
          title={t("settings:subagentSettings.workMode")}
          description={t("settings:subagentSettings.delegateOnDemandOrLetTheMain")}
        >
          <Select
            label={t("settings:subagentSettings.subagentWorkMode")}
            panelTitle={t("settings:subagentSettings.workMode")}
            size="compact"
            variant="menu"
            value={policy.mode}
            options={[
              { value: "opportunistic", label: t("settings:subagentSettings.onDemand") },
              { value: "orchestrator", label: t("settings:subagentSettings.orchestration") },
            ]}
            disabled={configurationLocked}
            onValueChange={(mode) => void save({ ...policy, mode }).catch(() => {})}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings:subagentSettings.maximumNestingDepth")}
          description={t("settings:subagentSettings.theMainThreadIsLevel0Set")}
        >
          <SettingsNumber
            label={t("settings:subagentSettings.maximumNestingDepth")}
            value={policy.maxDepth}
            minimum={0}
            maximum={10}
            disabled={configurationLocked}
            onChange={(maxDepth) => void save({ ...policy, maxDepth }).catch(() => {})}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings:subagentSettings.concurrentTasks")}
          description={t("settings:subagentSettings.countedSeparatelyForEachChatAdditionalTasks")}
        >
          <SettingsNumber
            label={t("settings:subagentSettings.numberOfConcurrentSubagents")}
            value={policy.maxConcurrent}
            minimum={1}
            maximum={32}
            disabled={configurationLocked}
            onChange={(maxConcurrent) => void save({ ...policy, maxConcurrent }).catch(() => {})}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings:subagentSettings.enabledModels")}
          description={t("settings:subagentSettings.usesOnlyTheCurrentMainModelBy")}
        >
          {Boolean(policy.allowedModels?.length) && (
            <Button
              variant="link"
              size="compact"
              disabled={configurationLocked}
              onClick={() => {
                const { allowedModels: _models, ...rest } = policy;
                void save(rest).catch(() => {});
              }}
            >
              {t("settings:subagentSettings.useTheMainModel")}
            </Button>
          )}
          <ModelPicker
            models={library.models}
            providers={library.providers}
            disabled={configurationLocked}
            side="bottom"
            showThinking={false}
            selection={{
              models: enabledModels,
              label: modelLabel(enabledModels, t("settings:subagentSettings.chooseAModel")),
              onChange: (allowedModels) => {
                if (!allowedModels.length) {
                  setError(
                    localizedMessage("settings:subagentSettings.keepAtLeastOneModelEnabled"),
                  );
                  return;
                }
                void save({ ...policy, allowedModels }).catch(() => {});
              },
            }}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings:subagentSettings.agentPresets")}>
        <SettingsRow
          title={t("settings:subagentSettings.presetConfiguration")}
          description={t(
            "settings:subagentSettings.saveInstructionsThinkingLevelsAndCandidateModels",
          )}
        >
          <Button
            variant="ghost"
            size="compact"
            disabled={configurationLocked}
            onClick={() => edit()}
          >
            {t("settings:subagentSettings.addPreset")}
          </Button>
        </SettingsRow>
        {policy.presets.map((preset) => (
          <SettingsRow
            key={preset.name}
            title={preset.name}
            description={`${thinkingOptions().find((option) => option.value === preset.thinkingLevel)?.label ?? preset.thinkingLevel} · ${modelLabel(preset.models, t("settings:subagentSettings.useTheMainModel"))}`}
          >
            <Button
              variant="ghost"
              size="compact"
              disabled={configurationLocked}
              onClick={() => edit(preset)}
            >
              {t("settings:subagentSettings.edit")}
            </Button>
            <Button
              variant="ghost-destructive"
              size="compact"
              disabled={configurationLocked}
              onClick={() =>
                void save({
                  ...policy,
                  presets: policy.presets.filter((entry) => entry.name !== preset.name),
                }).catch(() => {})
              }
            >
              {t("settings:subagentSettings.delete")}
            </Button>
          </SettingsRow>
        ))}
        {editing !== undefined && (
          <form
            className="py-3"
            onSubmit={(event) => {
              event.preventDefault();
              const preset = {
                name: name.trim(),
                instructions,
                thinkingLevel,
                models,
                canDelegate,
              };
              void save({
                ...policy,
                presets: [...policy.presets.filter((preset) => preset.name !== editing), preset],
              })
                .then(() => setEditing(undefined))
                .catch(() => {});
            }}
          >
            <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
              <Input
                variant="compact"
                aria-label={t("settings:subagentSettings.presetName")}
                placeholder={t("settings:subagentSettings.presetNameSuchAsQuickOrReviewer")}
                value={name}
                onValueChange={setName}
                disabled={configurationLocked}
              />
              <Select
                label={t("settings:subagentSettings.presetThinkingLevel")}
                panelTitle={t("settings:subagentSettings.thinkingLevel")}
                size="compact"
                variant="menu"
                value={thinkingLevel}
                options={thinkingOptions()}
                onValueChange={setThinkingLevel}
                disabled={configurationLocked}
              />
            </div>
            <div className="mb-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
              <Textarea
                aria-label={t("settings:subagentSettings.presetInstructions")}
                placeholder={t("settings:subagentSettings.taskResponsibilitiesAndConstraints")}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                disabled={configurationLocked}
              />
            </div>
            <SettingsRow
              title={t("settings:subagentSettings.allowFurtherDelegation")}
              description={t("settings:subagentSettings.enableForPresetsThatCoordinateOtherAgents")}
            >
              <Switch
                aria-label={t("settings:subagentSettings.allowThePresetToDelegateFurther")}
                checked={canDelegate}
                disabled={configurationLocked}
                onCheckedChange={setCanDelegate}
              />
            </SettingsRow>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ModelPicker
                models={enabledCatalog}
                providers={library.providers}
                showThinking={false}
                side="bottom"
                disabled={configurationLocked}
                selection={{
                  models,
                  label: modelLabel(models, t("settings:subagentSettings.useTheMainModel")),
                  onChange: setModels,
                }}
              />
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={locked}
                  onClick={() => setEditing(undefined)}
                >
                  {t("settings:subagentSettings.cancel")}
                </Button>
                <Button type="submit" size="compact" disabled={configurationLocked || !name.trim()}>
                  {t("settings:subagentSettings.save")}
                </Button>
              </div>
            </div>
          </form>
        )}
      </SettingsSection>
    </>
  );
}
