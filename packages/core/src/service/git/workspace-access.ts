import { isAbsolute, join, relative, sep } from "node:path";
import { Context, Effect, Layer } from "effect";
import { GitStoreService } from "./store.ts";
import { CoreError } from "../errors.ts";

/** Both paths are canonical; sibling names must not count as descendants. */
export function containsDirectory(root: string, cwd: string) {
  const path = relative(root, cwd);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

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
      const removing = (cwd: string) => {
        for (const root of removals) if (containsDirectory(root, cwd)) return true;
        return false;
      };
      return WorkspaceAccessService.of({
        removing,
        reserveRemoval: (cwd) => {
          for (const root of removals)
            if (containsDirectory(root, cwd) || containsDirectory(cwd, root))
              throw new CoreError({ code: "Busy", message: "工作区正在移除" });
          removals.add(cwd);
          return () => {
            removals.delete(cwd);
          };
        },
        reason: Effect.fn("WorkspaceAccessService.reason")(function* (cwd: string) {
          if (removing(cwd)) return "工作区正在移除，暂不能执行";
          const receipt = Object.values((yield* store.read).worktrees ?? {}).find(
            (value) =>
              value.status !== "ready" &&
              (value.managed
                ? containsDirectory(value.path, cwd)
                : join(value.path, value.prefix) === cwd),
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
