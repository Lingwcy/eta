import { TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ChatWelcome({
  projectName,
  connecting,
  canStart,
  busy,
  onStart,
  hasWorkspace,
}: {
  projectName?: string;
  connecting: boolean;
  canStart: boolean;
  busy: boolean;
  onStart: () => void;
  hasWorkspace: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center pt-8 pb-11 text-center">
      <TerminalSquare
        className="mb-6 text-neutral-300"
        size={50}
        strokeWidth={1.4}
        aria-hidden="true"
      />
      <h2 className="text-[22px]/normal font-normal tracking-tight text-balance min-[901px]:text-[clamp(22px,2.3vw,30px)]">
        {projectName ? (
          <>
            你想让我们在{" "}
            <span className="underline decoration-neutral-300 decoration-dotted decoration-1 underline-offset-4">
              {projectName}
            </span>{" "}
            中构建什么？
          </>
        ) : (
          "今天想构建什么？"
        )}
      </h2>
      {connecting && <output className="mt-3 text-xs text-neutral-400">正在准备 Agent…</output>}
      {canStart && (
        <div className="mt-3">
          <Button variant="ghost-muted" size="compact" disabled={busy} onClick={onStart}>
            {hasWorkspace ? "新建聊天，开始协作" : "打开项目，开始协作"}
          </Button>
        </div>
      )}
    </div>
  );
}
