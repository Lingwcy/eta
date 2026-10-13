import { useEffect, useState } from "react";
import { Check, GitBranch, Plus } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandGroupLabel,
} from "@/components/ui/command";
import type { GitBranch as Branch, GitRepositoryInfo } from "@eta/core/shared/git";
import { worktreeBranchName } from "@eta/core/shared/git";
import type { WorktreeBranch } from "@eta/core/service/git/worktrees";

/** Draft-only choice; nothing is created until the first message is sent. */
export interface WorktreeDraft {
  readonly enabled: boolean;
  readonly branch?: WorktreeBranch;
}

const suffix = () => crypto.randomUUID().slice(0, 4);

function label(draft: WorktreeDraft, info: GitRepositoryInfo | undefined, worktree: boolean) {
  if (draft.enabled && draft.branch)
    return draft.branch.kind === "new"
      ? `新 worktree · ${draft.branch.name}`
      : `worktree · ${draft.branch.name}`;
  if (info?.status !== "ready") return worktree ? "工作树" : "分支";
  const head = info.head.kind === "detached" ? info.head.sha.slice(0, 7) : info.head.name;
  return worktree ? `工作树 · ${head}` : head;
}

/** What choosing a branch from the list means for the draft. */
function choose(branch: Branch): WorktreeBranch {
  if (branch.kind === "remote")
    // A remote branch always gets an explicit local branch before checkout.
    return {
      kind: "new",
      name: worktreeBranchName(branch.name.replace(/^[^/]+\//, ""), suffix()),
      baseRef: branch.name,
    };
  if (branch.current || branch.checkedOutAt)
    // A branch checked out elsewhere can only be a base for a new branch.
    return { kind: "new", name: worktreeBranchName(branch.name, suffix()), baseRef: branch.name };
  return { kind: "existing", name: branch.name };
}

export function WorktreePicker({
  workspaceId,
  worktree,
  unsupported,
  draft,
  disabled,
  onChange,
}: {
  workspaceId: string | null;
  /** The selected workspace already is a worktree. */
  worktree: boolean;
  /** Why worktrees cannot be used here (e.g. an older Bot), shown instead of the controls. */
  unsupported?: string;
  draft: WorktreeDraft;
  disabled: boolean;
  onChange: (draft: WorktreeDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [info, setInfo] = useState<GitRepositoryInfo>();
  const [branches, setBranches] = useState<readonly Branch[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setInfo(undefined);
    setBranches([]);
    setError(undefined);
    if (!workspaceId || unsupported) return;
    let cancelled = false;
    // The current branch label must come from the live checkout, so it reloads whenever the menu opens.
    void Promise.all([window.eta.gitRepository(workspaceId), window.eta.gitBranches(workspaceId)])
      .then(([repository, list]) => {
        if (cancelled) return;
        setInfo(repository);
        setBranches(list);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取分支");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, unsupported, open]);
  if (!workspaceId) return null;
  const ready = info?.status === "ready" && info.head.kind !== "unborn";
  const reason =
    unsupported ??
    error ??
    (info?.status === "not-repository"
      ? "此项目不是 Git 仓库，可以直接聊天，但不能创建 worktree。"
      : info?.status === "unavailable"
        ? info.message
        : info?.status === "ready" && info.head.kind === "unborn"
          ? "仓库还没有提交，不能创建 worktree。"
          : undefined);
  const filtered = branches.filter((branch) =>
    branch.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const selected = (branch: Branch) =>
    draft.enabled
      ? draft.branch?.kind === "existing"
        ? draft.branch.name === branch.name
        : draft.branch?.baseRef === branch.name
      : branch.current;
  const pick = (branch: Branch) => onChange({ enabled: true, branch: choose(branch) });
  const newBranch = () =>
    onChange({
      enabled: true,
      branch: { kind: "new", name: worktreeBranchName("work", suffix()) },
    });
  const group = (kind: Branch["kind"], title: string) => {
    const items = filtered.filter((branch) => branch.kind === kind);
    if (!items.length) return null;
    return (
      <>
        <CommandGroupLabel>{title}</CommandGroupLabel>
        {items.map((branch) => (
          <CommandItem
            variant="menu"
            key={`${kind}:${branch.name}`}
            value={branch}
            title={
              branch.checkedOutAt
                ? `已在 ${branch.checkedOutAt} 检出，将以它为基线新建分支`
                : branch.name
            }
            onClick={() => pick(branch)}
          >
            <GitBranch size={15} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{branch.name}</span>
            {branch.checkedOutAt && (
              <span className="shrink-0 text-[11px] text-neutral-400">已检出</span>
            )}
            {selected(branch) && <Check size={16} aria-hidden="true" />}
          </CommandItem>
        ))}
      </>
    );
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label="工作区与分支"
        render={<Button variant="ghost" size="pill" selected={open || draft.enabled} />}
      >
        <GitBranch size={15} aria-hidden="true" />
        <span className="max-w-48 truncate">{label(draft, info, worktree)}</span>
      </PopoverTrigger>
      <PopoverContent variant="menu" aria-label="工作区与分支">
        <label className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs text-neutral-700">
          <span>在新 worktree 中开始</span>
          <Switch
            checked={draft.enabled}
            disabled={!draft.enabled && (!ready || Boolean(reason))}
            onCheckedChange={(enabled) =>
              onChange(
                enabled
                  ? {
                      enabled,
                      branch: draft.branch ?? {
                        kind: "new",
                        name: worktreeBranchName("work", suffix()),
                      },
                    }
                  : { enabled: false },
              )
            }
          />
        </label>
        {reason ? (
          <p className="max-w-64 px-2 pb-2 text-xs text-neutral-500">{reason}</p>
        ) : (
          <>
            <p className="max-w-64 px-2 pb-1 text-[11px] text-neutral-400">
              {draft.enabled
                ? "发送第一条消息时创建 worktree，不会带上当前目录未提交的改动。"
                : "选择分支会改为在新 worktree 中使用它，当前目录保持不变。"}
            </p>
            {draft.enabled && draft.branch?.kind === "new" && (
              <div className="px-2 pb-1.5">
                <Input
                  aria-label="新分支名称"
                  value={draft.branch.name}
                  onChange={(event) =>
                    onChange({
                      enabled: true,
                      branch: { ...draft.branch, kind: "new", name: event.target.value },
                    })
                  }
                />
              </div>
            )}
            <div className="mx-1.5 my-1 h-px shrink-0 bg-black/10" />
            <Command
              items={filtered}
              mode="none"
              inline
              open
              autoHighlight={false}
              value={query}
              onValueChange={setQuery}
              itemToStringValue={(branch) => branch.name}
            >
              <CommandInput variant="menu-search" aria-label="搜索分支" placeholder="搜索分支" />
              <CommandList size="menu">
                {group("local", "本地分支")}
                {group("remote", "远端跟踪分支")}
                {!filtered.length && (
                  <p className="px-2 py-3 text-xs text-neutral-400">
                    {info ? "没有匹配的分支" : "正在读取分支"}
                  </p>
                )}
              </CommandList>
            </Command>
            <div className="mx-1.5 my-1 h-px shrink-0 bg-black/10" />
            <Button variant="menu" size="menu-item" onClick={newBranch} disabled={!ready}>
              <Plus size={16} aria-hidden="true" />
              新建分支…
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
