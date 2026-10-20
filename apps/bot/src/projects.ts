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

/** A path that vanished, is not a directory, or cannot be canonicalised (symlink loop). */
const unresolvable = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP");

/** The Bot owns directory discovery; Core only receives validated project paths. */
export class BotProjects {
  readonly workspaceProjects = new Map<string, string>();
  readonly projectKeys = new Map<string, string>();
  private refreshing: Promise<void> | undefined;
  private publishedRoot: string | undefined;
  private publicationRevision = 0;
  constructor(
    private readonly core: CoreClient,
    private readonly config: BotConfig,
  ) {}

  private async inside(path: string, root: string) {
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
    const root = await realpath(this.config.workspaceRoot);
    if (!(await this.inside(path, root)))
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

  async refreshForThread(id: string) {
    for (;;) {
      // A full scan publishes both maps together. Validate after its publication, not into
      // a snapshot that may still replace this target entry.
      await this.refreshing;
      const revision = this.publicationRevision;
      const thread = await this.core.threadMetadata(id);
      const [projects, workspaces] = await Promise.all([
        this.core.projects(),
        this.core.workspaces(),
      ]);
      const workspace = workspaces.find((value) => value.id === thread.workspaceId);
      const project = projects.find((value) => value.id === workspace?.projectId);
      if (!workspace || !project) return this.refresh();
      await mkdir(this.config.workspaceRoot, { recursive: true });
      const root = await realpath(this.config.workspaceRoot);
      const suffix = relative(root, project.rootPath);
      // Hidden/nested canonical paths depend on visible aliases; duplicate roots depend on
      // discovery ordering. Keep the full scan as their source of ownership truth.
      if (
        !suffix ||
        suffix.startsWith(".") ||
        suffix.includes(sep) ||
        isAbsolute(suffix) ||
        projects.some((value) => value.id !== project.id && value.rootPath === project.rootPath)
      )
        return this.refresh();
      let available = false;
      try {
        available =
          (await this.inside(project.rootPath, root)) && (await this.inside(workspace.cwd, root));
      } catch (error) {
        if (!unresolvable(error)) throw error;
      }
      const currentRoot = await realpath(this.config.workspaceRoot);
      // Recheck after any newer publication, including scans that already finished and
      // target checks that revoked this workspace or changed the root namespace.
      if (this.refreshing || this.publicationRevision !== revision) continue;
      if (currentRoot !== root) {
        this.workspaceProjects.clear();
        this.projectKeys.clear();
        this.publishedRoot = undefined;
        this.publicationRevision++;
        throw new BotHttpError(
          403,
          "ProjectUnavailable",
          "Workspace root changed during validation.",
        );
      }
      if (this.publishedRoot !== root) {
        this.workspaceProjects.clear();
        this.projectKeys.clear();
        this.publishedRoot = root;
      }
      this.publicationRevision++;
      if (available) this.workspaceProjects.set(workspace.id, project.id);
      else this.workspaceProjects.delete(workspace.id);
      return;
    }
  }

  private async scan() {
    await mkdir(this.config.workspaceRoot, { recursive: true });
    const root = await realpath(this.config.workspaceRoot);
    const existing = await this.core.projects();
    const existingByPath = new Map<string, string>();
    for (const project of existing) {
      const path = project.rootPath;
      if (!existingByPath.has(path)) existingByPath.set(path, project.id);
    }
    const projects = new Map<string, string>();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const path = join(root, entry.name);
      try {
        if (!(await this.inside(path, root))) continue;
        if (!(await stat(path)).isDirectory()) continue;
        const canonical = await realpath(path);
        const projectId =
          existingByPath.get(canonical) ?? (await this.core.registerProject(path)).id;
        projects.set(canonical, projectId);
      } catch (error) {
        if (!unresolvable(error)) throw error;
        continue;
      }
    }
    for (const project of existing) {
      const suffix = relative(root, project.rootPath);
      if (!suffix || suffix.startsWith(".") || suffix.includes(sep) || isAbsolute(suffix)) continue;
      try {
        if (await this.inside(project.rootPath, root)) projects.set(project.rootPath, project.id);
      } catch (error) {
        if (!unresolvable(error)) throw error;
        continue;
      }
    }
    const projectIds = new Set(projects.values());
    const workspaces = new Map<string, string>();
    for (const workspace of await this.core.workspaces()) {
      if (!projectIds.has(workspace.projectId)) continue;
      try {
        if (await this.inside(workspace.cwd, root))
          workspaces.set(workspace.id, workspace.projectId);
      } catch (error) {
        if (!unresolvable(error)) throw error;
        continue;
      }
    }
    const keys = new Map<string, string>();
    for (const [path, id] of projects) keys.set(relative(root, path), id);
    // Optional stable aliases are only used by extensions and never grant access outside the root.
    for (const alias of this.config.projects ?? []) {
      try {
        const id = projects.get(await canonical(resolve(alias.rootPath)));
        if (id) keys.set(alias.key, id);
      } catch (error) {
        if (!unresolvable(error)) throw error;
        continue;
      }
    }
    // Use one root for the whole scan, then revalidate before publishing either ownership map.
    if ((await realpath(this.config.workspaceRoot)) !== root) {
      this.workspaceProjects.clear();
      this.projectKeys.clear();
      this.publishedRoot = undefined;
      this.publicationRevision++;
      throw new BotHttpError(403, "ProjectUnavailable", "Workspace root changed during discovery.");
    }
    this.workspaceProjects.clear();
    for (const [id, projectId] of workspaces) this.workspaceProjects.set(id, projectId);
    this.projectKeys.clear();
    for (const [key, id] of keys) this.projectKeys.set(key, id);
    this.publishedRoot = root;
    this.publicationRevision++;
  }
}
