import { renderMessage } from "@/i18n/messages";
import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { Check, ChevronRight, GitBranch, Plus, Settings, Split } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandGroup,
  CommandGroupLabel,
} from "@/components/ui/command";
import type { GitBranch as Branch, GitRepositoryInfo } from "@eta/core/shared/git";
import { worktreeBranchName } from "@eta/core/shared/git";
import type { WorktreeBranch } from "@eta/core/service/git/worktrees";
import { newWorktreeBranch } from "./worktree-draft";

/** Draft-only choice; nothing is created until the first message is sent. */
export interface WorktreeDraft {
  readonly enabled: boolean;
  readonly branch?: WorktreeBranch;
}

const suffix = () => crypto.randomUUID().slice(0, 4);

function label(draft: WorktreeDraft, info: GitRepositoryInfo | undefined, worktree: boolean) {
  if (draft.enabled && draft.branch) return draft.branch.name;
  if (info?.status !== "ready")
    return worktree ? t("chat:worktreePicker.worktree") : t("chat:worktreePicker.branch");
  const head = info.head.kind === "detached" ? info.head.sha.slice(0, 7) : info.head.name;
  return worktree ? t("chat:worktreePicker.worktree2", { head: head }) : head;
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
  useTranslation();
  const [open, setOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [query, setQuery] = useState("");
  const [info, setInfo] = useState<GitRepositoryInfo>();
  const [branches, setBranches] = useState<readonly Branch[]>([]);
  const [error, setError] = useState<Message>();
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
        if (!cancelled)
          setError(
            describeError(reason, localizedMessage("chat:worktreePicker.cannotReadBranches")),
          );
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
      ? t("chat:worktreePicker.thisProjectIsNotAGitRepository")
      : info?.status === "unavailable"
        ? info.message
        : info?.status === "ready" && info.head.kind === "unborn"
          ? t("chat:worktreePicker.thisRepositoryHasNoCommitsYetA")
          : undefined);
  const filtered = branches.filter((branch) =>
    branch.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const selected = (branch: Branch) =>
    draft.enabled
      ? draft.branch?.kind === "existing"
        ? draft.branch.name === branch.name
        : draft.branch?.baseRef === branch.name || (!draft.branch?.baseRef && branch.current)
      : branch.current;
  const pick = (branch: Branch) => {
    onChange({ enabled: true, branch: choose(branch) });
    setBranchOpen(false);
  };
  const newBranch = () => {
    onChange({
      enabled: true,
      branch: newWorktreeBranch(draft.branch, suffix()),
    });
    setNaming(true);
  };
  const confirmBranch = () => {
    if (!draft.branch?.name.trim()) return;
    setNaming(false);
    setBranchOpen(false);
  };
  const changes =
    info?.status === "ready"
      ? info.changes.staged +
        info.changes.unstaged +
        info.changes.untracked +
        info.changes.conflicted
      : 0;
  const group = (kind: Branch["kind"], title: string) => {
    const items = filtered.filter((branch) => branch.kind === kind);
    if (!items.length) return null;
    return (
      <CommandGroup key={kind}>
        <CommandGroupLabel>{title}</CommandGroupLabel>
        {items.map((branch) => (
          <CommandItem
            variant={branch.current && changes ? "menu-detail" : "menu"}
            key={`${kind}:${branch.name}`}
            value={branch}
            title={
              branch.checkedOutAt
                ? t("chat:worktreePicker.alreadyCheckedOutAtANewBranch", {
                    checkedOutAt: branch.checkedOutAt,
                  })
                : branch.name
            }
            onClick={() => pick(branch)}
          >
            <GitBranch size={15} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{branch.name}</span>
              {branch.current && changes > 0 && (
                <span className="block text-[11px] opacity-60">
                  {t("chat:worktreePicker.uncommittedChanges", { count: changes })}
                </span>
              )}
            </span>
            {selected(branch) && <Check size={16} aria-hidden="true" />}
          </CommandItem>
        ))}
      </CommandGroup>
    );
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setBranchOpen(false);
          setNaming(false);
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={t("chat:worktreePicker.configureWorkspace")}
        title={label(draft, info, worktree)}
        render={<Button variant="ghost-muted" size="icon-xs" selected={open || draft.enabled} />}
      >
        <Settings size={15} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent variant="menu" aria-label={t("chat:worktreePicker.workspaceAndBranch")}>
        <p className="px-2 py-1 text-xs text-neutral-400">
          {t("chat:worktreePicker.configureWorkspace")}
        </p>
        <label className="flex h-[26px] items-center gap-1.5 px-2 text-xs text-neutral-800">
          <Split size={14} aria-hidden="true" />
          <span className="flex-1">{t("chat:worktreePicker.newWorktree")}</span>
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
          <p className="max-w-64 px-2 pb-2 text-xs text-neutral-500">{renderMessage(reason)}</p>
        ) : (
          <Popover
            open={branchOpen}
            onOpenChange={(next) => {
              setBranchOpen(next);
              setQuery("");
              if (!next) {
                setNaming(false);
              }
            }}
          >
            <PopoverTrigger disabled={!ready} render={<Button variant="menu" size="menu-item" />}>
              <GitBranch size={14} aria-hidden="true" />
              <span>{t("chat:worktreePicker.branch")}</span>
              <span className="ml-auto min-w-0 flex-1 truncate text-right opacity-60">
                {label(draft, info, worktree)}
              </span>
              <ChevronRight size={14} aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent
              variant="menu"
              side="inline-end"
              aria-label={t("chat:worktreePicker.chooseABranch")}
            >
              {naming && draft.branch?.kind === "new" ? (
                <div className="flex items-center gap-1 px-2">
                  <GitBranch size={14} className="shrink-0 stroke-[1.7]" aria-hidden="true" />
                  <Input
                    autoFocus
                    variant="menu"
                    aria-label={t("chat:worktreePicker.newBranchName")}
                    value={draft.branch.name}
                    onChange={(event) =>
                      onChange({
                        enabled: true,
                        branch: { ...draft.branch, kind: "new", name: event.target.value },
                      })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        confirmBranch();
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon-tiny"
                    aria-label={t("chat:worktreePicker.useThisBranch")}
                    title={t("chat:worktreePicker.useThisBranch")}
                    disabled={!draft.branch.name.trim()}
                    onClick={confirmBranch}
                  >
                    <Check size={14} aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <>
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
                    <CommandInput
                      variant="menu-search"
                      aria-label={t("chat:worktreePicker.searchBranches")}
                      placeholder={t("chat:worktreePicker.searchBranches")}
                    />
                    <CommandList size="menu">
                      {group("local", t("chat:worktreePicker.localBranches"))}
                      {group("remote", t("chat:worktreePicker.remoteTrackingBranches"))}
                      {!filtered.length && (
                        <p className="px-2 py-3 text-xs text-neutral-400">
                          {info
                            ? t("chat:worktreePicker.noMatchingBranches")
                            : t("chat:worktreePicker.readingBranches")}
                        </p>
                      )}
                    </CommandList>
                  </Command>
                  <div className="mx-1.5 my-1 h-px shrink-0 bg-black/10" />
                  <Button variant="menu" size="menu-item" onClick={newBranch} disabled={!ready}>
                    <Plus size={16} aria-hidden="true" />
                    {t("chat:worktreePicker.createAndCheckOutANewBranch")}
                  </Button>
                </>
              )}
            </PopoverContent>
          </Popover>
        )}
      </PopoverContent>
    </Popover>
  );
}
