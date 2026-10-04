import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { threadProjectId } from "../service/threads/project.ts";
import type { CatalogState } from "../service/catalog/type.ts";
import type { StorageReport, StorageTarget } from "./types.ts";

/** Count session files without reading transcripts or following directory links. */
export async function scanStorage(root: string, catalog: CatalogState): Promise<StorageReport> {
  const dataRoot = resolve(root);
  const report: StorageReport = {
    paths: {
      sessions: join(dataRoot, "sessions"),
      modelConfiguration: join(dataRoot, "settings.json"),
      catalog: join(dataRoot, "catalog.json"),
    },
    sessionBytes: 0,
    sessions: [],
    issues: [],
  };
  const measure = async (path: string): Promise<number | null> => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        report.issues.push(`${relative(root, path)}：未统计符号链接`);
        return null;
      }
      if (info.isDirectory()) {
        let bytes = 0;
        for (const name of await readdir(path)) bytes += (await measure(join(path, name))) ?? 0;
        return bytes;
      }
      return info.isFile() ? info.size : 0;
    } catch (error) {
      report.issues.push(
        `${relative(root, path)}：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
  const sessionRoots = new Map<string, (typeof catalog.threads)[number]>();
  for (const thread of catalog.threads)
    sessionRoots.set(resolve(thread.sessionRef.metadata.path), thread);
  const projectName = (thread: (typeof catalog.threads)[number] | undefined) => {
    return thread
      ? catalog.projects.find((project) => project.id === threadProjectId(thread, catalog))?.name
      : undefined;
  };
  const names = await (async () => {
    const info = await lstat(report.paths.sessions);
    if (info.isSymbolicLink()) throw new Error("会话总目录不能是符号链接");
    return readdir(report.paths.sessions);
  })().catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  for (const name of names) {
    const path = join(report.paths.sessions, name);
    const bytes = await measure(path);
    const thread = sessionRoots.get(path);
    report.sessionBytes += bytes ?? 0;
    report.sessions.push({
      id: name,
      path,
      title: thread?.title || (name === ".trash" ? "已移除的会话数据" : name),
      project: projectName(thread),
      bytes,
    });
    sessionRoots.delete(path);
  }
  for (const [path, thread] of sessionRoots) {
    report.sessions.push({
      id: basename(path),
      path,
      title: thread.title,
      project: projectName(thread),
      bytes: null,
    });
    report.issues.push(`${thread.title || thread.id}：会话目录缺失或位于数据目录之外`);
  }
  return report;
}

/** Resolve a product identifier to an existing file inside the application data root. */
export async function storageTargetPath(root: string, target: StorageTarget) {
  if (
    target.kind !== "sessions" &&
    (basename(target.id) !== target.id ||
      target.id === "." ||
      target.id === ".." ||
      target.id.includes("\\"))
  )
    throw new Error("存储条目无效");
  if (target.kind === "configuration" && !["settings.json", "catalog.json"].includes(target.id))
    throw new Error("配置文件无效");
  const path =
    target.kind === "sessions"
      ? join(root, "sessions")
      : target.kind === "configuration"
        ? join(root, target.id)
        : join(root, "sessions", target.id);
  const actualRoot = await realpath(root);
  const actualPath = await realpath(path);
  const distance = relative(actualRoot, actualPath);
  if (distance === ".." || distance.startsWith(`..${sep}`) || isAbsolute(distance))
    throw new Error("存储条目不在应用数据目录中");
  return actualPath;
}
