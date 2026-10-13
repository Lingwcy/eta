import { EnvironmentPicker } from "./environment-picker";
import { WorktreePicker } from "./worktree-picker";
import type { WorktreeDraft } from "./worktree-picker";
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
  cloud,
  onEnvironment,
  onSettings,
  worktreeDraft,
  worktreeUnsupported,
  onWorktreeDraft,
}: {
  worktreeDraft: WorktreeDraft;
  worktreeUnsupported?: string;
  onWorktreeDraft: (draft: WorktreeDraft) => void;
  cloud: boolean;
  onEnvironment: (cloud: boolean) => void;
  onSettings: () => void;
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
    <div className="mx-5 -mb-1 flex h-[38px] items-center gap-3 rounded-t-2xl bg-neutral-200/60 px-3 pb-1 text-[13px] text-neutral-500 min-[701px]:mx-7 min-[901px]:gap-5">
      <EnvironmentPicker
        cloud={cloud}
        connected={library?.bot?.status === "connected"}
        disabled={busy}
        onChange={onEnvironment}
        onSettings={onSettings}
      />
      <Suspense
        fallback={
          <Button variant="ghost" size="pill" disabled>
            {projectName ?? "选择项目"}
          </Button>
        }
      >
        <ProjectPicker
          library={library}
          cloud={cloud}
          workspaceId={workspaceId}
          projectName={projectName}
          cwd={cwd}
          disabled={busy || !library}
          onSelect={onProject}
          onCreate={onCreateProject}
        />
      </Suspense>
      <span className="ml-auto flex min-w-0 items-center">
        <WorktreePicker
          workspaceId={workspaceId}
          worktree={worktree}
          draft={worktreeDraft}
          disabled={busy || !library}
          onChange={onWorktreeDraft}
          {...(worktreeUnsupported ? { unsupported: worktreeUnsupported } : {})}
        />
      </span>
    </div>
  );
}
