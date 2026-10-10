import { mkdir, readdir, realpath, lstat, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname, basename, sep } from "node:path";
import type { CoreClient } from "@eta/core";
import type { BotConfig } from "./config.ts";
import { BotHttpError } from "./errors.ts";

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    // Preserve unavailable checkout history, but never follow a dangling symlink.
    const entry = await lstat(path).catch((failure: unknown) => {
      if (failure instanceof Error && "code" in failure && failure.code === "ENOENT")
        return undefined;
      throw failure;
    });
    if (entry?.isSymbolicLink()) throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

/** The Bot owns directory discovery; Core only receives validated project paths. */
export class BotProjects {
  readonly workspaceProjects = new Map<string, string>();
  readonly projectKeys = new Map<string, string>();
  private refreshing: Promise<void> | undefined;
  constructor(
    private readonly core: CoreClient,
    private readonly config: BotConfig,
  ) {}

  private async inside(path: string) {
    const root = await realpath(this.config.workspaceRoot);
    const target = await canonical(path);
    const suffix = relative(root, target);
    return (
      suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
    );
  }

  async create(name: string) {
    if (
      name !== name.trim() ||
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      /\p{Cc}/u.test(name) ||
      name.startsWith(".")
    )
      throw new BotHttpError(400, "InvalidInput", "项目名称必须是根目录下的文件夹名称。");
    const path = join(this.config.workspaceRoot, name);
    // Existing ordinary directories can be adopted, including after an interrupted request.
    await mkdir(path, { recursive: true });
    if (!(await this.inside(path)))
      throw new BotHttpError(403, "ProjectUnavailable", "项目必须位于 Bot 工作空间根目录内。");
    const project = await this.core.registerProject(path, name);
    await this.refresh(true);
    return project;
  }

  async refresh(force = false) {
    if (force) await this.refreshing;
    return (this.refreshing ??= this.scan().finally(() => {
      this.refreshing = undefined;
    }));
  }

  private async scan() {
    await mkdir(this.config.workspaceRoot, { recursive: true });
    const root = await realpath(this.config.workspaceRoot);
    const existing = await this.core.projects();
    const projects = new Map<string, string>();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const path = join(root, entry.name);
      try {
        if (!(await this.inside(path))) continue;
        if (!(await stat(path)).isDirectory()) continue;
        const canonical = await realpath(path);
        const project =
          existing.find((value) => value.rootPath === canonical) ??
          (await this.core.registerProject(path));
        projects.set(canonical, project.id);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
          continue;
        throw error;
      }
    }
    for (const project of existing) {
      const suffix = relative(root, project.rootPath);
      if (!suffix || suffix.startsWith(".") || suffix.includes(sep) || isAbsolute(suffix)) continue;
      try {
        if (await this.inside(project.rootPath)) projects.set(project.rootPath, project.id);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
    const workspaces = new Map<string, string>();
    for (const workspace of await this.core.workspaces()) {
      if (![...projects.values()].includes(workspace.projectId)) continue;
      try {
        if (await this.inside(workspace.cwd)) workspaces.set(workspace.id, workspace.projectId);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
          continue;
        throw error;
      }
    }
    this.workspaceProjects.clear();
    for (const [id, projectId] of workspaces) this.workspaceProjects.set(id, projectId);
    this.projectKeys.clear();
    for (const [path, id] of projects) this.projectKeys.set(relative(root, path), id);
    // Optional stable aliases are only used by extensions and never grant access outside the root.
    for (const alias of this.config.projects ?? []) {
      try {
        const id = projects.get(await canonical(resolve(alias.rootPath)));
        if (id) this.projectKeys.set(alias.key, id);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
  }
}
