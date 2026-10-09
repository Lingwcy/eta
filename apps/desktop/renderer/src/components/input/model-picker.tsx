import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Button as BaseButton } from "@base-ui/react/button";
import { ChevronDown, ChevronUp, Grid2X2, Search, Check } from "lucide-react";
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
  providers = [],
  thinkingLevel = "off",
  showThinking = true,
  defaultOption,
  placeholder = "选择模型",
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
  providers?: readonly InputProvider[];
  thinkingLevel?: ThinkingLevel;
  showThinking?: boolean;
  defaultOption?: { label: string; selected: boolean; onSelect: () => void };
  placeholder?: string;
  side?: "top" | "bottom";
  disabled: boolean;
  onChange?: (model: InputModel, level: ThinkingLevel) => void;
  onSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerId, setProviderId] = useState<string | null>(model?.provider ?? null);
  const searchInput = useRef<HTMLInputElement>(null);
  const availableProviders = modelPickerProviders(models, providers);
  const activeProvider = availableProviders.some((provider) => provider.id === providerId)
    ? providerId
    : null;
  const visible = visiblePickerModels(models, availableProviders, activeProvider, query);
  const level = resolveThinkingLevel(model, thinkingLevel);
  const thinkingLabel =
    !selection && showThinking && model?.thinkingLevels.some((value) => value !== "off")
      ? thinkingOptions.find((option) => option.value === level)?.label
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
        if (next) setProviderId(model?.provider ?? null);
      }}
    >
      <Popover.Trigger
        disabled={disabled}
        aria-label={selection ? "选择启用的模型" : showThinking ? "选择模型与思考级别" : "选择模型"}
        title={model ? `${model.provider}/${model.id}` : placeholder}
        className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-transparent bg-transparent px-2.5 text-[13px] font-normal text-neutral-700 outline-none transition-colors hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 disabled:cursor-default [&_svg]:shrink-0"
      >
        {model && (
          <span aria-hidden="true" className="size-[18px] shrink-0 opacity-60">
            <ProviderMark id={model.provider} />
          </span>
        )}
        <span className="max-w-[105px] truncate min-[701px]:max-w-[150px] min-[901px]:max-w-[220px]">
          {selection?.label ??
            model?.name ??
            (defaultOption?.selected ? defaultOption.label : placeholder)}
        </span>
        {thinkingLabel && <span className="shrink-0 text-neutral-400">{thinkingLabel}</span>}
        {open ? (
          <ChevronUp size={14} aria-hidden="true" />
        ) : (
          <ChevronDown size={14} aria-hidden="true" />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align="end" sideOffset={8} className="z-30">
          <Popover.Popup
            aria-label="可用模型"
            initialFocus={searchInput}
            className="flex h-[min(288px,var(--available-height))] max-h-[calc(100dvh-32px)] w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[20px] border border-neutral-200 bg-white p-1 shadow-lg outline-none"
          >
            <nav
              aria-label="模型服务"
              className="w-10 shrink-0 overflow-y-auto rounded-2xl bg-neutral-50 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <BaseButton
                aria-label="所有模型"
                aria-pressed={activeProvider === null || Boolean(query.trim())}
                title="所有模型"
                onClick={() => {
                  setProviderId(null);
                  setQuery("");
                }}
                className={cn(
                  "mb-0.5 flex size-8 cursor-pointer items-center justify-center rounded-full text-neutral-400 outline-none hover:bg-neutral-200/60 focus-visible:ring-2 focus-visible:ring-neutral-400",
                  (activeProvider === null || query.trim()) && "bg-neutral-200/70 text-neutral-700",
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
                    "mb-0.5 flex size-8 cursor-pointer items-center justify-center rounded-full text-neutral-400 outline-none hover:bg-neutral-200/60 focus-visible:ring-2 focus-visible:ring-neutral-400",
                    activeProvider === provider.id &&
                      !query.trim() &&
                      "bg-neutral-200/70 text-neutral-700",
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
                {!query && <span className="text-xs text-neutral-400">模型</span>}
                <div className="relative min-w-0 flex-1">
                  <input
                    ref={searchInput}
                    type="search"
                    aria-label="搜索模型或服务"
                    placeholder="快速搜索"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-7 w-full min-w-0 bg-transparent pr-5 text-xs text-neutral-900 outline-none placeholder:text-neutral-400 [&::-webkit-search-cancel-button]:hidden"
                  />
                  <Search
                    size={15}
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 text-neutral-400"
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
                        "flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-[10px] py-2 pr-2 pl-1.5 text-left text-[13px] text-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-400 disabled:cursor-default",
                        defaultOption.selected ? "bg-neutral-100" : "hover:bg-neutral-50",
                      )}
                    >
                      <Grid2X2 size={18} aria-hidden="true" className="shrink-0 opacity-50" />
                      <span className="min-w-0 flex-1 truncate">{defaultOption.label}</span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-300",
                          defaultOption.selected && "border-neutral-900 bg-neutral-900",
                        )}
                      >
                        {defaultOption.selected && (
                          <span className="size-[5px] rounded-full bg-white" />
                        )}
                      </span>
                    </BaseButton>
                  )}
                  {visible.map((entry) => {
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
                      <div
                        key={`${entry.provider}/${entry.id}`}
                        className={cn(
                          "relative min-h-9 rounded-[10px]",
                          selected && "bg-neutral-100",
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
                            "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-[10px] py-2 pr-2 pl-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-400 disabled:cursor-default",
                            selected ? "hover:bg-neutral-100" : "hover:bg-neutral-50",
                          )}
                        >
                          <span aria-hidden="true" className="size-[18px] shrink-0 opacity-50">
                            <ProviderMark id={entry.provider} />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-900">
                            {entry.name}
                            {(query.trim() || activeProvider === null) && (
                              <span className="ml-1.5 text-neutral-400">{providerName}</span>
                            )}
                          </span>
                          {showThinkingControl && (
                            <span aria-hidden="true" className="w-14 shrink-0" />
                          )}
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex size-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-300",
                              selected && "border-neutral-900 bg-neutral-900",
                              selection && "rounded-[4px]",
                            )}
                          >
                            {selected &&
                              (selection ? (
                                <Check size={10} className="text-white" />
                              ) : (
                                <span className="size-[5px] rounded-full bg-white" />
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
                    );
                  })}
                  {!visible.length && (
                    <p className="px-3 py-10 text-center text-xs text-neutral-400">
                      {models.length ? "没有匹配的模型" : "请先连接模型服务"}
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
                    连接模型服务
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
