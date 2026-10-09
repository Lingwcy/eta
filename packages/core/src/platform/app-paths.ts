import { resolve } from "node:path";
import { Context, Layer } from "effect";

interface AppPathValues {
  readonly dataRoot: string; // 持久化数据的根目录
  readonly sessionsRoot: string; // JSONL 会话目录的存储根目录
  readonly catalogPath: string; // 保存 project、workspace、thread 之间的产品关系
  readonly settingsPath: string; // 全局设置
}

export function makeAppPaths(dataRoot: string) {
  const root = resolve(dataRoot);
  return {
    dataRoot: root,
    sessionsRoot: resolve(root, "sessions"),
    catalogPath: resolve(root, "catalog.json"),
    settingsPath: resolve(root, "settings.json"),
  } satisfies AppPathValues;
}

export class AppPathsService extends Context.Service<AppPathsService, AppPathValues>()(
  "eta/core/platform/AppPathsService",
) {
  static readonly layer = (dataRoot: string) =>
    Layer.succeed(AppPathsService, AppPathsService.of(makeAppPaths(dataRoot)));
}
