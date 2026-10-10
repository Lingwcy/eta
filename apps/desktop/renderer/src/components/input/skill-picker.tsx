import { useEffect, useState } from "react";
import { BookOpen, X } from "lucide-react";
import type { ActiveSkill, SkillCatalog } from "@eta/core/skills/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

export function SkillPicker({
  cwd,
  workspaceId,
  threadId,
  activeSkills = [],
  active,
  disabled,
  onSelect,
  onSettings,
}: {
  cwd?: string;
  workspaceId?: string | null;
  threadId?: string;
  activeSkills?: readonly ActiveSkill[];
  active: boolean;
  disabled: boolean;
  onSelect: (name: string) => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<SkillCatalog>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!active) {
      setOpen(false);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || disabled) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, disabled]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalog(undefined);
    setError(undefined);
    window.eta
      .skills(cwd, workspaceId ?? undefined)
      .then((value) => {
        if (!cancelled) setCatalog(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(error instanceof Error ? error.message : "无法发现技能");
      });
    const unsubscribe = window.eta.subscribeLibrary(() => setRevision((value) => value + 1));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open, cwd, workspaceId, revision]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            disabled={disabled}
            aria-label="选择技能"
            title="选择技能 · Cmd/Ctrl+Shift+K"
          />
        }
      >
        <BookOpen size={17} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent variant="menu" aria-label="选择技能">
        <div className="flex h-7 shrink-0 items-center justify-between pl-2">
          <span className="text-xs font-medium">技能</span>
          <Button
            variant="link"
            size="compact"
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            管理
          </Button>
        </div>
        <div className="mx-1.5 my-1 h-px shrink-0 bg-black/10" />
        <ScrollArea className="max-h-60 min-h-0 flex-1">
          <div className="space-y-0.5">
            {activeSkills.map((skill) => (
              <div key={skill.id} className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate px-2 text-xs" title={skill.directory}>
                  {skill.name} · 已加载
                </span>
                <Button
                  variant="ghost-destructive"
                  size="icon-tiny"
                  disabled={disabled || busy || !threadId}
                  aria-label={`移除已加载技能 ${skill.name}`}
                  onClick={() => {
                    if (!threadId) return;
                    setBusy(true);
                    void window.eta
                      .unloadSkill(threadId, skill.name)
                      .catch((error: unknown) => {
                        setError(error instanceof Error ? error.message : "无法移除技能");
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </Button>
              </div>
            ))}
            {catalog?.skills
              .filter((skill) => skill.enabled)
              .map((skill) => (
                <Button
                  key={skill.id}
                  variant="menu"
                  size="row-sm"
                  disabled={disabled || busy}
                  title={skill.description}
                  onClick={() => {
                    onSelect(skill.name);
                    setOpen(false);
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-xs">{skill.name}</span>
                    <span className="truncate text-[11px] leading-3.5 opacity-60">
                      {skill.description}
                    </span>
                  </span>
                </Button>
              ))}
            {!catalog && !error && <p className="p-2 text-xs text-neutral-500">正在发现技能…</p>}
            {catalog && !catalog.skills.some((skill) => skill.enabled) && (
              <p className="p-2 text-xs text-neutral-500">
                没有已启用的技能。可以在设置中添加技能目录。
              </p>
            )}
            {error && (
              <p role="alert" className="p-2 text-xs text-red-600">
                {error}
              </p>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
