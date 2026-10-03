import { FolderClosed, GitBranch, Laptop } from "lucide-react";
import { Button } from "@/components/ui/button";
export function ComposerContext({
  projectName,
  cwd,
  worktree,
  busy,
  onProject,
}: {
  projectName?: string;
  cwd?: string;
  worktree: boolean;
  busy: boolean;
  onProject: () => void;
}) {
  return (
    <div className="mx-2 flex items-center gap-3 rounded-t-2xl bg-neutral-100 px-3 pt-2 pb-3 text-[13px] text-neutral-700 min-[701px]:mx-3.5 min-[901px]:gap-5">
      <Button
        variant="ghost"
        size="compact"
        disabled={busy}
        onClick={onProject}
        title={cwd ?? "选择项目"}
      >
        <FolderClosed size={17} aria-hidden="true" />
        <span className="max-w-40 truncate">{projectName ?? "选择项目"}</span>
      </Button>
      <span className="hidden items-center gap-2 min-[701px]:flex">
        <Laptop size={18} aria-hidden="true" />
        此计算机
      </span>
      {worktree && (
        <span className="ml-auto flex items-center gap-1.5">
          <GitBranch size={15} aria-hidden="true" />
          工作树
        </span>
      )}
    </div>
  );
}
