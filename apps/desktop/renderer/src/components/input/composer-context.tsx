import { GitBranch, Laptop } from "lucide-react";
import { lazy, Suspense } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { Button } from "@/components/ui/button";

const ProjectPicker = lazy(() =>
  import("@/components/projects/project-picker").then((module) => ({
    default: module.ProjectPicker,
  })),
);

export function ComposerContext({
  projectName,
  cwd,
  worktree,
  busy,
  library,
  workspaceId,
  onProject,
  onCreateProject,
}: {
  projectName?: string;
  cwd?: string;
  worktree: boolean;
  busy: boolean;
  library: DesktopLibrary | null;
  workspaceId: string | null;
  onProject: (id: string | null) => void;
  onCreateProject: (rootPath: string, name: string) => Promise<void>;
}) {
  return (
    <div className="mx-2 flex items-center gap-3 rounded-t-2xl bg-neutral-100 px-3 pt-2 pb-3 text-[13px] text-neutral-700 min-[701px]:mx-3.5 min-[901px]:gap-5">
      <Suspense
        fallback={
          <Button variant="secondary" size="pill" disabled>
            {projectName ?? "选择项目"}
          </Button>
        }
      >
        <ProjectPicker
          library={library}
          workspaceId={workspaceId}
          projectName={projectName}
          cwd={cwd}
          disabled={busy || !library}
          onSelect={onProject}
          onCreate={onCreateProject}
        />
      </Suspense>
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
