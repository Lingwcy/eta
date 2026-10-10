import { EnvironmentPicker } from "./environment-picker";
import { GitBranch } from "lucide-react";
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
}: {
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
      <EnvironmentPicker
        cloud={cloud}
        connected={library?.bot?.status === "connected"}
        disabled={busy}
        onChange={onEnvironment}
        onSettings={onSettings}
      />
      {worktree && (
        <span className="ml-auto flex items-center gap-1.5">
          <GitBranch size={15} aria-hidden="true" />
          工作树
        </span>
      )}
    </div>
  );
}
