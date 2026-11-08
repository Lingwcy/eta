import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Button as BaseButton } from "@base-ui/react/button";
import { Brain, ChevronDown, ChevronUp, Grid2X2, Search, Check } from "lucide-react";
import type { ThinkingLevel } from "@eta/core/agent/protocol";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { InputModel, InputProvider } from "./types";
import { resolveThinkingLevel, thinkingOptions } from "./model-thinking";
import { modelPickerProviders, visiblePickerModels } from "./model-picker-options";
import { ProviderMark } from "./provider-mark";
import { ThinkingLevelControl } from "./thinking-level-control";

export function ModelPicker({
  model,
  selection,
  models,
  recentModels = [],
  providers = [],
  thinkingLevel = "off",
  showThinking = true,
  responsive = false,
  defaultOption,
  placeholder = t("chat:modelPicker.chooseAModel"),
  side = "top",
  disabled,
  onChange,
  onSettings,
}: {
  model?: InputModel;
  selection?: {
    models: readonly { provider: string; modelId: string }[];
    label?: string;
    onChange: (models: readonly { provider: string; modelId: string }[]) => void;
  };
  models: readonly InputModel[];
  recentModels?: readonly { provider: string; modelId: string }[];
  providers?: readonly InputProvider[];
  thinkingLevel?: ThinkingLevel;
  showThinking?: boolean;
  responsive?: boolean;
  defaultOption?: { label: string; selected: boolean; onSelect: () => void };
  placeholder?: string;
  side?: "top" | "bottom";
  disabled: boolean;
  onChange?: (model: InputModel, level: ThinkingLevel) => void;
  onSettings?: () => void;
}) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerId, setProviderId] = useState<string | null>(model?.provider ?? null);
  const searchInput = useRef<HTMLInputElement>(null);
  const availableProviders = modelPickerProviders(models, providers);
  const activeProvider = availableProviders.some((provider) => provider.id === providerId)
    ? providerId
    : null;
  const visible = visiblePickerModels(models, availableProviders, activeProvider, query);
  const recent =
    !selection && !query.trim() && activeProvider === null
      ? recentModels.flatMap((item) => {
          const found = visible.find(
            (entry) => entry.provider === item.provider && entry.id === item.modelId,
          );
          return found ? [found] : [];
        })
      : [];
  const ordered = [...recent, ...visible.filter((entry) => !recent.includes(entry))];
  const level = resolveThinkingLevel(model, thinkingLevel);
  const thinkingLabel =
    !selection && showThinking && model?.thinkingLevels.some((value) => value !== "off")
      ? thinkingOptions().find((option) => option.value === level)?.label
      : undefined;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // Saving temporarily disables the focused model row; that should not dismiss the picker.
        if (!next && details.reason === "focus-out") {
          details.cancel();
          return;
        }
        setOpen(next);
        setQuery("");
        if (next) setProviderId(recentModels.length ? null : (model?.provider ?? null));
      }}
    >
      <Popover.Trigger
        disabled={disabled}
        aria-label={
          selection
            ? t("chat:modelPicker.chooseEnabledModels")
            : showThinking
              ? t("chat:modelPicker.chooseAModelAndThinkingLevel")
              : t("chat:modelPicker.chooseAModel")
        }
        title={model ? `${model.provider}/${model.id}` : placeholder}
        className={cn(
          "inline-flex h-8 min-w-0 cursor-pointer items-center justify-center rounded-full border border-transparent bg-transparent text-[13px] font-normal text-strong outline-none transition-colors hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-focus-ring-400 focus-visible:ring-offset-2 disabled:cursor-default [&_svg]:shrink-0",
          responsive
            ? "w-8 gap-0 px-0 @min-[520px]/composer:w-auto @min-[520px]/composer:gap-1.5 @min-[520px]/composer:px-2.5"
            : "gap-1.5 px-2.5",
        )}
      >
        {(model || responsive) && (
          <span aria-hidden="true" className="size-[18px] shrink-0 opacity-60">
            {model ? <ProviderMark id={model.provider} /> : <Brain size={18} />}
          </span>
        )}
        <span
          className={cn(
            "min-w-0 truncate",
            responsive
              ? "hidden max-w-[100px] @min-[520px]/composer:inline @min-[760px]/composer:max-w-[150px] @min-[900px]/composer:max-w-[220px]"
              : "max-w-[72px] min-[701px]:max-w-[150px] min-[901px]:max-w-[220px]",
          )}
        >
          {selection?.label ??
            model?.name ??
            (defaultOption?.selected ? defaultOption.label : placeholder)}
        </span>
        {thinkingLabel && (
          <span
            className={cn(
              "shrink-0 text-subtle",
              responsive && "hidden max-w-12 truncate @min-[520px]/composer:inline",
            )}
          >
            {thinkingLabel}
          </span>
        )}
        <span
          className={cn("inline-flex", responsive && "hidden @min-[520px]/composer:inline-flex")}
        >
          {open ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align="end" sideOffset={8} className="z-50">
          <Popover.Popup
            aria-label={t("chat:modelPicker.availableModels")}
            initialFocus={searchInput}
            className="flex max-h-[min(288px,var(--available-height),calc(100dvh-32px))] w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[14px] border border-border bg-surface p-1 shadow-lg outline-none"
          >
            <nav
              aria-label={t("chat:modelPicker.modelProviders")}
              className="w-10 shrink-0 overflow-y-auto rounded-[10px] bg-surface-soft p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <BaseButton
                aria-label={t("chat:modelPicker.allModels")}
                aria-pressed={activeProvider === null || Boolean(query.trim())}
                title={t("chat:modelPicker.allModels")}
                onClick={() => {
                  setProviderId(null);
                  setQuery("");
                }}
                className={cn(
                  "mb-0.5 flex size-8 cursor-pointer items-center justify-center rounded-full text-subtle outline-none hover:bg-surface-hover/60 focus-visible:ring-2 focus-visible:ring-focus-ring-400",
                  (activeProvider === null || query.trim()) && "bg-surface-hover/70 text-strong",
                )}
              >
                <Grid2X2 size={17} aria-hidden="true" />
              </BaseButton>
              {availableProviders.map((provider) => (
                <BaseButton
                  key={provider.id}
                  aria-label={provider.name}
                  aria-pressed={activeProvider === provider.id && !query.trim()}
                  title={provider.name}
                  onClick={() => {
                    setProviderId(provider.id);
                    setQuery("");
                  }}
                  className={cn(
                    "mb-0.5 flex size-8 cursor-pointer items-center justify-center rounded-full text-subtle outline-none hover:bg-surface-hover/60 focus-visible:ring-2 focus-visible:ring-focus-ring-400",
                    activeProvider === provider.id &&
                      !query.trim() &&
                      "bg-surface-hover/70 text-strong",
                  )}
                >
                  <span aria-hidden="true" className="size-5 opacity-60">
                    <ProviderMark id={provider.id} />
                  </span>
                </BaseButton>
              ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col pl-1.5">
              <div className="flex h-8 shrink-0 items-center gap-2 pr-2 pl-1.5">
                {!query && (
                  <span className="text-xs text-subtle">{t("chat:modelPicker.models")}</span>
                )}
                <div className="relative min-w-0 flex-1">
                  <input
                    ref={searchInput}
                    type="search"
                    aria-label={t("chat:modelPicker.searchModelsOrProviders")}
                    placeholder={t("chat:modelPicker.quickSearch")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-7 w-full min-w-0 bg-transparent pr-5 text-xs text-foreground outline-none placeholder:text-subtle [&::-webkit-search-cancel-button]:hidden"
                  />
                  <Search
                    size={15}
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 text-subtle"
                  />
                </div>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-0.5 pb-1">
                  {defaultOption && (
                    <BaseButton
                      aria-pressed={defaultOption.selected}
                      disabled={disabled}
                      onClick={() => {
                        defaultOption.onSelect();
                        setOpen(false);
                      }}
                      className={cn(
                        "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-[8px] py-1.5 pr-2 pl-1.5 text-left text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring-400 disabled:cursor-default",
                        defaultOption.selected ? "bg-surface-subtle" : "hover:bg-surface-soft",
                      )}
                    >
                      <Grid2X2 size={18} aria-hidden="true" className="shrink-0 opacity-50" />
                      <span className="min-w-0 flex-1 truncate">{defaultOption.label}</span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center rounded-full border border-border-strong",
                          defaultOption.selected && "border-solid-border bg-solid",
                        )}
                      >
                        {defaultOption.selected && (
                          <span className="size-[5px] rounded-full bg-surface" />
                        )}
                      </span>
                    </BaseButton>
                  )}
                  {ordered.map((entry, index) => {
                    const selected = selection
                      ? selection.models.some(
                          (model) =>
                            model.provider === entry.provider && model.modelId === entry.id,
                        )
                      : entry.provider === model?.provider && entry.id === model.id;
                    const showThinkingControl =
                      !selection &&
                      showThinking &&
                      selected &&
                      entry.thinkingLevels.some((value) => value !== "off");
                    const providerName =
                      availableProviders.find((provider) => provider.id === entry.provider)?.name ??
                      entry.provider;
                    return (
                      <div key={JSON.stringify([entry.provider, entry.id])}>
                        {recent.length > 0 && (index === 0 || index === recent.length) && (
                          <p className="px-1.5 pt-2 pb-1 text-xs text-subtle">
                            {index === 0
                              ? t("chat:modelPicker.recentModels")
                              : t("chat:modelPicker.models")}
                          </p>
                        )}
                        <div
                          className={cn(
                            "relative min-h-8 rounded-[8px]",
                            selected && "bg-surface-subtle",
                          )}
                        >
                          <BaseButton
                            aria-pressed={selected}
                            disabled={disabled || (!onChange && !selection)}
                            title={`${entry.provider}/${entry.id}`}
                            onClick={() => {
                              if (selection)
                                selection.onChange(
                                  selected
                                    ? selection.models.filter(
                                        (model) =>
                                          model.provider !== entry.provider ||
                                          model.modelId !== entry.id,
                                      )
                                    : [
                                        ...selection.models,
                                        { provider: entry.provider, modelId: entry.id },
                                      ],
                                );
                              else {
                                onChange?.(entry, resolveThinkingLevel(entry, thinkingLevel));
                                if (!showThinking) setOpen(false);
                              }
                            }}
                            className={cn(
                              "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-[8px] py-1.5 pr-2 pl-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring-400 disabled:cursor-default",
                              selected ? "hover:bg-surface-subtle" : "hover:bg-surface-soft",
                            )}
                          >
                            <span aria-hidden="true" className="size-[18px] shrink-0 opacity-50">
                              <ProviderMark id={entry.provider} />
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                              {entry.name}
                              {(query.trim() || activeProvider === null) && (
                                <span className="ml-1.5 text-subtle">{providerName}</span>
                              )}
                            </span>
                            {showThinkingControl && (
                              <span aria-hidden="true" className="w-14 shrink-0" />
                            )}
                            <span
                              aria-hidden="true"
                              className={cn(
                                "flex size-3.5 shrink-0 items-center justify-center rounded-full border border-border-strong",
                                selected && "border-solid-border bg-solid",
                                selection && "rounded-[4px]",
                              )}
                            >
                              {selected &&
                                (selection ? (
                                  <Check size={10} className="text-on-solid" />
                                ) : (
                                  <span className="size-[5px] rounded-full bg-surface" />
                                ))}
                            </span>
                          </BaseButton>
                          {showThinkingControl && (
                            <div className="absolute top-1/2 right-8 -translate-y-1/2">
                              <ThinkingLevelControl
                                key={`${entry.provider}/${entry.id}`}
                                level={level}
                                levels={entry.thinkingLevels}
                                disabled={disabled || (!onChange && !selection)}
                                onChange={(next) => onChange?.(entry, next)}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {!visible.length && (
                    <p className="px-3 py-10 text-center text-xs text-subtle">
                      {models.length
                        ? t("chat:modelPicker.noMatchingModels")
                        : t("chat:modelPicker.connectAModelProviderFirst")}
                    </p>
                  )}
                </div>
              </ScrollArea>
              {!models.length && (
                <div className="p-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!onSettings}
                    onClick={() => {
                      setOpen(false);
                      onSettings?.();
                    }}
                  >
                    {t("chat:modelPicker.connectAModelProvider")}
                  </Button>
                </div>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
