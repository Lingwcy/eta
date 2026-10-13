import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { GitStoreService } from "./store.ts";
import { CoreError } from "../errors.ts";

/** Removal excludes new execution claims; persistent tombstones stay blocked even if the directory is recreated. */
export class WorkspaceAccessService extends Context.Service<
  WorkspaceAccessService,
  {
    reason(cwd: string): Effect.Effect<string | undefined, CoreError>;
    removing(cwd: string): boolean;
    reserveRemoval(cwd: string): () => void;
  }
>()("eta/core/git/WorkspaceAccessService") {
  static readonly layer = Layer.effect(
    WorkspaceAccessService,
    Effect.gen(function* () {
      const store = yield* GitStoreService;
      const removals = new Set<string>();
      return WorkspaceAccessService.of({
        removing: (cwd) => removals.has(cwd),
        reserveRemoval: (cwd) => {
          if (removals.has(cwd)) throw new CoreError({ code: "Busy", message: "工作区正在移除" });
          removals.add(cwd);
          return () => {
            removals.delete(cwd);
          };
        },
        reason: Effect.fn("WorkspaceAccessService.reason")(function* (cwd: string) {
          if (removals.has(cwd)) return "工作区正在移除，暂不能执行";
          const receipt = Object.values((yield* store.read).worktrees ?? {}).find(
            (value) => join(value.path, value.prefix) === cwd,
          );
          if (receipt && receipt.status !== "ready")
            return receipt.status === "removed"
              ? "工作区已移除，历史仍可查看；请从保留分支开始新会话"
              : (receipt.reason ?? "工作区尚未就绪，请先核对工作区");
          return undefined;
        }),
      });
    }),
  );
}
