import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ThinkingLevel } from "../../../../src/agent/protocol.ts";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import type { InputModel } from "./types";

const thinkingOptions = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" },
] satisfies { value: ThinkingLevel; label: string }[];

export function ModelPicker({
  model,
  models,
  thinkingLevel = "off",
  disabled,
  onChange,
  onSettings,
}: {
  model?: InputModel;
  models: readonly InputModel[];
  thinkingLevel?: ThinkingLevel;
  disabled: boolean;
  onChange?: (model: InputModel, level: ThinkingLevel) => void;
  onSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const visible = models.filter((entry) =>
    `${entry.name} ${entry.provider} ${entry.id}`.toLocaleLowerCase().includes(search),
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" size="compact" disabled={disabled} />}
        aria-label="选择模型与思考级别"
        title={model ? `${model.provider}/${model.id}` : "选择模型"}
      >
        <span className="max-w-[105px] truncate min-[701px]:max-w-[150px] min-[901px]:max-w-[220px]">
          {model?.name ?? "选择模型"}
        </span>
        {thinkingLevel !== "off" && (
          <span className="text-neutral-400">
            {thinkingOptions.find((option) => option.value === thinkingLevel)?.label}
          </span>
        )}
        <ChevronDown size={13} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent aria-label="可用模型">
        <div className="shrink-0 border-b border-neutral-100 p-3">
          <SearchInput
            aria-label="搜索可用模型"
            placeholder="搜索模型或服务"
            value={query}
            onValueChange={setQuery}
          />
        </div>
        <ScrollArea className="h-[280px] min-h-0">
          <div className="p-1.5">
            {visible.map((entry) => {
              const selected = entry.provider === model?.provider && entry.id === model.id;
              return (
                <Button
                  key={`${entry.provider}/${entry.id}`}
                  variant="ghost"
                  size="row"
                  selected={selected}
                  aria-pressed={selected}
                  disabled={disabled || !onChange}
                  title={`${entry.provider}/${entry.id}`}
                  onClick={() => {
                    onChange?.(entry, thinkingLevel);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm">{entry.name}</span>
                    <span className="truncate text-xs text-neutral-400">{entry.provider}</span>
                  </span>
                  {selected && <Check size={15} aria-hidden="true" />}
                </Button>
              );
            })}
            {!visible.length && (
              <p className="px-3 py-6 text-center text-xs text-neutral-400">
                {models.length ? "没有匹配的模型" : "请先连接模型服务"}
              </p>
            )}
          </div>
        </ScrollArea>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-neutral-100 px-3 py-2.5">
          {models.length ? (
            <>
              <span className="text-xs text-neutral-500">思考级别</span>
              <Select
                label="思考级别"
                size="compact"
                value={thinkingLevel}
                options={thinkingOptions}
                disabled={disabled || !model || !onChange}
                onValueChange={(level) => {
                  if (model) onChange?.(model, level);
                }}
              />
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                onSettings?.();
              }}
              disabled={!onSettings}
            >
              连接模型服务
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
