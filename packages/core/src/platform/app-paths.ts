import { basename, dirname, join, resolve } from "node:path";
import { Context, Layer } from "effect";

interface AppPathValues {
  readonly dataRoot: string; // 持久化数据的根目录
  readonly sessionsRoot: string; // JSONL 会话目录的存储根目录
  readonly catalogPath: string; // 保存 project、workspace、thread 之间的产品关系
  readonly settingsPath: string; // 全局设置
  readonly reviewLogPath: string; // 沙盒自动审查的本地追加记录
  readonly scheduleStorePath: string; // 独立版本化的定时任务与投递收据
  readonly gitStorePath: string; // Git 绑定、remote 选择与 worktree 生命周期收据
  readonly temporaryWorkspacesRoot: string;
}

export function makeAppPaths(dataRoot: string, temporaryWorkspacesRoot?: string) {
  const root = resolve(dataRoot);
  return {
    dataRoot: root,
    // Stay outside denied application data; the hidden sibling also avoids Bot project discovery.
    temporaryWorkspacesRoot: temporaryWorkspacesRoot
      ? resolve(temporaryWorkspacesRoot)
      : join(dirname(root), `.${basename(root)}-workspaces`),
    sessionsRoot: resolve(root, "sessions"),
    catalogPath: resolve(root, "catalog.json"),
    settingsPath: resolve(root, "settings.json"),
    reviewLogPath: resolve(root, "approval-reviews.jsonl"),
    gitStorePath: resolve(root, "git.json"),
    scheduleStorePath: resolve(root, "schedules.json"),
  } satisfies AppPathValues;
}

export class AppPathsService extends Context.Service<AppPathsService, AppPathValues>()(
  "eta/core/platform/AppPathsService",
) {
  static readonly layer = (dataRoot: string, temporaryWorkspacesRoot?: string) =>
    Layer.succeed(
      AppPathsService,
      AppPathsService.of(makeAppPaths(dataRoot, temporaryWorkspacesRoot)),
    );
}
