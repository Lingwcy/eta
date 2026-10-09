import { useEffect, useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { defaultSubagentSettings } from "../../../../src/subagents.ts";
import type { SubagentSettings as Policy } from "../../../../src/subagents.ts";
import { SettingsSection, SettingsRow } from "./settings-section";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ModelPicker } from "../input/model-picker";
import { thinkingOptions } from "../input/model-thinking";
import { Alert } from "@/components/ui/alert";
import type { ThinkingLevel } from "../../../../src/agent/protocol.ts";

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
  busy,
  onChange,
}: {
  library: DesktopLibrary;
  busy: boolean;
  onChange: (subagents: Policy) => Promise<void>;
}) {
  const policy = library.settings.subagents ?? defaultSubagentSettings;
  const enabled = policy.enabled !== false;
  const mainModel =
    library.subagentDefaultModel ??
    (() => {
      const model =
        library.models.find(
          (model) =>
            model.provider === library.settings.defaultProvider &&
            model.id === library.settings.defaultModel,
        ) ?? library.models[0];
      return model && { provider: model.provider, modelId: model.id };
    })();
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
        ? `${models.length} 个模型`
        : empty;
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [canDelegate, setCanDelegate] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const [models, setModels] = useState<Preset["models"]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const configurationLocked = locked || !enabled;
  const save = async (next: Policy) => {
    setSaving(true);
    setError(undefined);
    try {
      await onChange(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败");
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
      {error && <Alert>{error}</Alert>}
      <SettingsSection title="首选项">
        <SettingsRow
          title="启用子智能体"
          description="允许智能体委派任务。关闭后已有任务继续收尾，历史仍可查看和停止。"
        >
          <Switch
            aria-label="启用子智能体"
            checked={enabled}
            disabled={locked}
            onCheckedChange={(enabled) => void save({ ...policy, enabled }).catch(() => {})}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="委派设置">
        <SettingsRow title="工作模式" description="按需委派，或由主线程专注交流与编排。">
          <Select
            label="子智能体工作模式"
            panelTitle="工作模式"
            size="compact"
            variant="menu"
            value={policy.mode}
            options={[
              { value: "opportunistic", label: "按需" },
              { value: "orchestrator", label: "编排" },
            ]}
            disabled={configurationLocked}
            onValueChange={(mode) => void save({ ...policy, mode }).catch(() => {})}
          />
        </SettingsRow>
        <SettingsRow title="最大嵌套深度" description="主线程为第 0 层，设为 0 可停用创建。">
          <SettingsNumber
            label="最大嵌套深度"
            value={policy.maxDepth}
            minimum={0}
            maximum={10}
            disabled={configurationLocked}
            onChange={(maxDepth) => void save({ ...policy, maxDepth }).catch(() => {})}
          />
        </SettingsRow>
        <SettingsRow title="同时执行数量" description="每个会话单独计算，超出数量的任务排队。">
          <SettingsNumber
            label="同时执行的子智能体数量"
            value={policy.maxConcurrent}
            minimum={1}
            maximum={32}
            disabled={configurationLocked}
            onChange={(maxConcurrent) => void save({ ...policy, maxConcurrent }).catch(() => {})}
          />
        </SettingsRow>
        <SettingsRow title="启用模型" description="默认仅使用当前主模型，可在此启用其他模型。">
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
              跟随主模型
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
              label: modelLabel(enabledModels, "选择模型"),
              onChange: (allowedModels) => {
                if (!allowedModels.length) {
                  setError("至少保留一个启用模型。");
                  return;
                }
                void save({ ...policy, allowedModels }).catch(() => {});
              },
            }}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="智能体预设">
        <SettingsRow title="预设配置" description="为不同任务保存指令、思考级别和候选模型。">
          <Button
            variant="ghost"
            size="compact"
            disabled={configurationLocked}
            onClick={() => edit()}
          >
            添加预设
          </Button>
        </SettingsRow>
        {policy.presets.map((preset) => (
          <SettingsRow
            key={preset.name}
            title={preset.name}
            description={`${thinkingOptions.find((option) => option.value === preset.thinkingLevel)?.label ?? preset.thinkingLevel} · ${modelLabel(preset.models, "跟随主模型")}`}
          >
            <Button
              variant="ghost"
              size="compact"
              disabled={configurationLocked}
              onClick={() => edit(preset)}
            >
              编辑
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
              删除
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
                aria-label="预设名称"
                placeholder="预设名称，如 quick 或 reviewer"
                value={name}
                onValueChange={setName}
                disabled={configurationLocked}
              />
              <Select
                label="预设思考级别"
                panelTitle="思考级别"
                size="compact"
                variant="menu"
                value={thinkingLevel}
                options={thinkingOptions}
                onValueChange={setThinkingLevel}
                disabled={configurationLocked}
              />
            </div>
            <div className="mb-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
              <Textarea
                aria-label="预设任务指令"
                placeholder="任务职责和约束"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                disabled={configurationLocked}
              />
            </div>
            <SettingsRow
              title="允许继续委派"
              description="为需要协调其他智能体的预设开启；执行任务的预设默认直接完成工作。"
            >
              <Switch
                aria-label="允许预设继续委派"
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
                selection={{ models, label: modelLabel(models, "跟随主模型"), onChange: setModels }}
              />
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={locked}
                  onClick={() => setEditing(undefined)}
                >
                  取消
                </Button>
                <Button type="submit" size="compact" disabled={configurationLocked || !name.trim()}>
                  保存
                </Button>
              </div>
            </div>
          </form>
        )}
      </SettingsSection>
    </>
  );
}
