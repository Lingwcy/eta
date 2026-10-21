import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Context, DateTime, Effect, Layer, Semaphore } from "effect";
import { runGit } from "../../platform/git.ts";
import type { GitBranch, WorktreeSummary } from "../../shared/git.ts";
import { CatalogService } from "../catalog/index.ts";
import { CoreEnvironmentService } from "../environment.ts";
import { adapter, CoreError } from "../errors.ts";
import { AppPathsService } from "../../platform/app-paths.ts";
import { RuntimeRegistryService } from "../runtime/index.ts";
import { WorkspaceService } from "../workspaces/index.ts";
import { BRANCH_FORMAT, inspectRepository, parseBranches } from "./index.ts";
import { GitStoreService } from "./store.ts";
import type { WorktreeReceipt } from "./store.ts";
import { WorkspaceAccessService } from "./workspace-access.ts";

export type WorktreeBranch =
  | { readonly kind: "new"; readonly name: string; readonly baseRef?: string }
  | { readonly kind: "existing"; readonly name: string };

export interface CreateWorktreeInput {
  readonly projectId: string;
  readonly baseWorkspaceId: string;
  readonly branch: WorktreeBranch;
  readonly requestId: string;
  /** A removed workspace whose history this one continues. */
  readonly continuesWorkspaceId?: string;
}

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Serialises Eta's own writes per repository; Git's locks still guard against other tools. */
const repositoryLocks = new Map<string, Promise<unknown>>();
async function withRepositoryLock<A>(commonDir: string, run: () => Promise<A>) {
  const previous = repositoryLocks.get(commonDir) ?? Promise.resolve();
  const next = previous.then(run, run);
  repositoryLocks.set(
    commonDir,
    next.catch(() => undefined),
  );
  return next;
}

const git = async (cwd: string, args: readonly string[], message: string) => {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0)
    throw new CoreError({
      code: /\.lock|lock file/i.test(result.stderr) ? "Busy" : "InvalidInput",
      message: `${message}：${result.stderr.trim().split("\n").at(-1) ?? ""}`,
    });
  return result.stdout;
};

/** Paths registered in `git worktree list`, keyed by canonical worktree root. */
async function registeredWorktrees(root: string) {
  const output = await git(
    root,
    ["worktree", "list", "--porcelain", "-z"],
    "无法读取 worktree 列表",
  );
  const paths = new Set<string>();
  for (const line of output.split("\0"))
    if (line.startsWith("worktree "))
      paths.add(await realpath(line.slice(9)).catch(() => line.slice(9)));
  return paths;
}

/**
 * Drops only this worktree's administrative entry once its directory is gone; `git worktree prune`
 * would also clear stale entries that belong to other tools.
 */
async function forgetWorktree(commonDir: string, path: string) {
  const admin = join(commonDir, "worktrees");
  for (const name of await readdir(admin).catch(() => [])) {
    const gitdir = (await readFile(join(admin, name, "gitdir"), "utf8").catch(() => "")).trim();
    if (gitdir === join(path, ".git"))
      await rm(join(admin, name), { recursive: true, force: true });
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

export class WorktreeService extends Context.Service<
  WorktreeService,
  {
    create(input: CreateWorktreeInput): Effect.Effect<WorktreeSummary, CoreError>;
    list(projectId: string): Effect.Effect<readonly WorktreeSummary[], CoreError>;
    remove(workspaceId: string, requestId: string): Effect.Effect<WorktreeSummary, CoreError>;
    reconcile(projectId: string): Effect.Effect<readonly WorktreeSummary[], CoreError>;
  }
>()("eta/core/service/git/WorktreeService") {
  static readonly layer = Layer.effect(
    WorktreeService,
    Effect.gen(function* () {
      const store = yield* GitStoreService;
      const workspaces = yield* WorkspaceService;
      const catalog = yield* CatalogService;
      const registry = yield* RuntimeRegistryService;
      const environment = yield* CoreEnvironmentService;
      const paths = yield* AppPathsService;
      const access = yield* WorkspaceAccessService;
      // The whole data directory is protected by the sandbox; managed checkouts must be its sibling.
      const managedRoot =
        environment.worktreeRoot ??
        join(dirname(paths.dataRoot), `${basename(paths.dataRoot)}-worktrees`);
      const now = Effect.map(DateTime.now, DateTime.toEpochMillis);

      const save = (requestId: string, change: (receipt: WorktreeReceipt) => WorktreeReceipt) =>
        store.update((state) => {
          const current = state.worktrees?.[requestId];
          if (!current) return state;
          return { ...state, worktrees: { ...state.worktrees, [requestId]: change(current) } };
        });
      const summary = (receipt: WorktreeReceipt, requestId: string): WorktreeSummary => ({
        requestId,
        projectId: receipt.projectId,
        path: receipt.path,
        cwd: receipt.prefix ? join(receipt.path, receipt.prefix) : receipt.path,
        branch: receipt.branch,
        baseSha: receipt.baseSha,
        createdBranch: receipt.createdBranch,
        managed: receipt.managed,
        status: receipt.status,
        createdAt: receipt.createdAt,
        ...(receipt.workspaceId ? { workspaceId: receipt.workspaceId } : {}),
        ...(receipt.reason ? { reason: receipt.reason } : {}),
        ...(receipt.continues ? { continues: receipt.continues } : {}),
        ...(receipt.removedAt ? { removedAt: receipt.removedAt } : {}),
      });
      const receipts = (projectId: string) =>
        Effect.map(store.read, (state) =>
          Object.entries(state.worktrees ?? {}).filter(
            ([, receipt]) => receipt.projectId === projectId,
          ),
        );
      const busy = Effect.fn("WorktreeService.busy")(function* (workspaceId: string) {
        for (const thread of (yield* catalog.read).threads) {
          if (thread.workspaceId !== workspaceId) continue;
          const runtime = yield* registry.peek(thread.sessionRef);
          if (
            runtime &&
            (runtime.running ||
              runtime.recoveryRequired ||
              (yield* adapter("无法检查任务", runtime.hasWork)))
          )
            return true;
        }
        return false;
      });

      /** Brings a receipt in line with Git and the filesystem without restoring deleted files. */
      const settle = Effect.fn("WorktreeService.settle")(function* (
        requestId: string,
        receipt: WorktreeReceipt,
      ) {
        const registered = yield* adapter(
          "无法读取 worktree 列表",
          () => registeredWorktrees(receipt.commonDir),
          "WorkspaceUnavailable",
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!registered) return receipt;
        const present = registered.has(receipt.path);
        const onDisk = yield* Effect.promise(() => exists(receipt.path));
        let next = receipt;
        if (receipt.status === "creating" && present && onDisk) {
          const cwd = receipt.prefix ? join(receipt.path, receipt.prefix) : receipt.path;
          const workspace = yield* workspaces.register(receipt.projectId, cwd).pipe(
            Effect.mapError(
              (error) =>
                new CoreError({
                  code: "WorkspaceUnavailable",
                  message: error instanceof CoreError ? error.message : "无法登记工作区",
                }),
            ),
          );
          next = { ...receipt, workspaceId: workspace.id, status: "ready" };
        } else if (receipt.status === "creating" && !present)
          next = { ...receipt, status: "needs_reconciliation", reason: "创建未完成，可重试" };
        else if (receipt.status === "removing")
          next = present
            ? { ...receipt, status: "ready" }
            : { ...receipt, status: "removed", removedAt: receipt.removedAt ?? Date.now() };
        else if (receipt.status === "ready" && (!present || !onDisk))
          next = {
            ...receipt,
            status: "needs_reconciliation",
            reason: "工作区目录已在 Eta 之外被移动或删除",
          };
        else if (
          // Only Eta's own worktrees recover by themselves; unverified adopted directories stay flagged.
          receipt.managed &&
          receipt.status === "needs_reconciliation" &&
          present &&
          onDisk &&
          receipt.workspaceId
        ) {
          const { reason: _reason, ...rest } = receipt;
          next = { ...rest, status: "ready" };
        }
        if (next.status === "ready" && onDisk) {
          const info = yield* Effect.promise(() =>
            inspectRepository(join(next.path, next.prefix), next.workspaceId ?? ""),
          );
          if (info.status !== "ready" || info.commonDir !== next.commonDir)
            next = { ...next, status: "needs_reconciliation", reason: "工作区的 Git 身份无法核实" };
          else if (info.head.kind === "branch" && info.head.name !== next.branch)
            next = { ...next, branch: info.head.name };
        }
        if (next !== receipt) yield* save(requestId, () => next);
        return next;
      });

      const create = Effect.fn("WorktreeService.create")(function* (input: CreateWorktreeInput) {
        const key = fingerprint({ op: "create", ...input });
        const state = yield* store.read;
        const known = state.requests?.[input.requestId];
        if (known && known !== key)
          return yield* new CoreError({
            code: "InvalidInput",
            message: "该请求 ID 已用于不同的参数",
          });
        const existing = state.worktrees?.[input.requestId];
        if (existing) {
          const settled = yield* settle(input.requestId, existing);
          if (settled.status !== "needs_reconciliation" || settled.workspaceId)
            return summary(settled, input.requestId);
          // An interrupted creation that never reached Git is retried below under the same receipt.
        }
        const base = yield* workspaces.get(input.baseWorkspaceId);
        if (base.projectId !== input.projectId)
          return yield* new CoreError({ code: "InvalidInput", message: "来源工作区不属于该项目" });
        const info = yield* Effect.promise(() => inspectRepository(base.cwd, base.id));
        if (info.status !== "ready")
          return yield* new CoreError({
            code: "InvalidInput",
            message: info.status === "not-repository" ? "该项目不是 Git 仓库" : info.message,
          });
        if (info.head.kind === "unborn")
          return yield* new CoreError({
            code: "InvalidInput",
            message: "仓库还没有提交，不能创建 worktree",
          });
        const projectRoot = (yield* workspaces.list(input.projectId)).find(
          (workspace) => workspace.kind === "project-root",
        );
        const owner =
          projectRoot &&
          (yield* Effect.promise(() => inspectRepository(projectRoot.cwd, projectRoot.id)));
        if (!owner || owner.status !== "ready" || owner.commonDir !== info.commonDir)
          return yield* new CoreError({
            code: "InvalidInput",
            message: "来源工作区不属于此项目的 Git 仓库",
          });
        const name = input.branch.name.trim();
        yield* adapter(
          "分支名无效",
          () => git(info.root, ["check-ref-format", "--branch", name], "分支名无效"),
          "InvalidInput",
        );
        const branches = parseBranches(
          yield* adapter(
            "无法读取分支",
            () => git(info.root, ["for-each-ref", BRANCH_FORMAT, "refs/heads"], "无法读取分支"),
            "WorkspaceUnavailable",
          ),
          "",
        );
        const local = branches.find((branch: GitBranch) => branch.name === name);
        let baseSha: string;
        if (input.branch.kind === "new") {
          if (local)
            return yield* new CoreError({
              code: "InvalidInput",
              message: `分支 ${name} 已存在；如需继续使用请选择已有分支`,
            });
          const ref = input.branch.baseRef ?? "HEAD";
          baseSha = (yield* adapter(
            "无法解析基线",
            () =>
              git(
                base.cwd,
                ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
                "无法解析基线",
              ),
            "InvalidInput",
          )).trim();
        } else {
          if (!local)
            return yield* new CoreError({ code: "InvalidInput", message: `分支 ${name} 不存在` });
          if (local.current || local.checkedOutAt)
            return yield* new CoreError({
              code: "Busy",
              message: `分支 ${name} 已在其他工作区检出`,
            });
          baseSha = local.sha;
        }
        const id = randomUUID().slice(0, 8);
        const path = join(managedRoot, `${basename(info.root)}-${id}`);
        const createdAt = yield* now;
        const receipt: WorktreeReceipt = {
          projectId: input.projectId,
          requestId: input.requestId,
          path,
          prefix: info.prefix,
          commonDir: info.commonDir,
          branch: name,
          createdBranch: input.branch.kind === "new",
          baseSha,
          managed: true,
          status: "creating",
          createdAt,
          ...(input.continuesWorkspaceId ? { continues: input.continuesWorkspaceId } : {}),
        };
        // The intent is durable before Git changes anything, so a crash leaves something to reconcile.
        yield* store.update((current) => ({
          ...current,
          requests: { ...current.requests, [input.requestId]: key },
          worktrees: { ...current.worktrees, [input.requestId]: receipt },
        }));
        const added = yield* adapter(
          "无法创建 worktree",
          () =>
            withRepositoryLock(info.commonDir, async () => {
              await mkdir(managedRoot, { recursive: true });
              await git(
                info.root,
                input.branch.kind === "new"
                  ? ["worktree", "add", "-b", name, path, baseSha]
                  : ["worktree", "add", path, name],
                "无法创建 worktree",
              );
              const canonical = await realpath(path);
              if (info.prefix && !(await exists(join(canonical, info.prefix)))) {
                // The project's subdirectory does not exist at this base; never fall back to the root.
                await git(info.root, ["worktree", "remove", canonical], "无法清理 worktree");
                throw new CoreError({
                  code: "InvalidInput",
                  message: `基线中不存在项目目录 ${info.prefix}`,
                });
              }
              return canonical;
            }),
          "WorkspaceUnavailable",
        ).pipe(
          Effect.tapError((error) =>
            save(input.requestId, (current) => ({
              ...current,
              status: "needs_reconciliation",
              reason: error.message,
            })),
          ),
        );
        const settled = yield* settle(input.requestId, { ...receipt, path: added });
        return summary(settled, input.requestId);
      });

      // Git's repository lock alone starts too late: duplicate callers could overwrite
      // the durable intent before either reaches worktree add. Re-read that intent under
      // the request gate, including the completed receipt's usual live validation.
      const createRequests = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
      return WorktreeService.of({
        create: (input) =>
          Effect.suspend(() => {
            let gate = createRequests.get(input.requestId);
            if (!gate) {
              gate = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
              createRequests.set(input.requestId, gate);
            }
            const current = gate;
            current.users++;
            return current.semaphore.withPermit(create(input)).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  current.users--;
                  if (current.users === 0) createRequests.delete(input.requestId);
                }),
              ),
            );
          }),
        list: Effect.fn("WorktreeService.list")(function* (projectId: string) {
          const results: WorktreeSummary[] = [];
          for (const [requestId, receipt] of yield* receipts(projectId))
            results.push(summary(yield* settle(requestId, receipt), requestId));
          return results;
        }),
        reconcile: Effect.fn("WorktreeService.reconcile")(function* (projectId: string) {
          // Catalog worktree records without a receipt are verified against the project's repository.
          const root = (yield* workspaces.list(projectId)).find(
            (value) => value.kind === "project-root",
          );
          const known = new Set(
            (yield* receipts(projectId)).map(([, receipt]) => receipt.workspaceId),
          );
          const rootInfo = root
            ? yield* Effect.promise(() => inspectRepository(root.cwd, root.id))
            : undefined;
          for (const workspace of yield* workspaces.list(projectId)) {
            if (workspace.kind !== "worktree" || known.has(workspace.id)) continue;
            const info = yield* Effect.promise(() =>
              inspectRepository(workspace.cwd, workspace.id),
            );
            const verified =
              info.status === "ready" &&
              rootInfo?.status === "ready" &&
              info.commonDir === rootInfo.commonDir;
            const requestId = `adopted:${workspace.id}`;
            const createdAt = yield* now;
            yield* store.update((state) => ({
              ...state,
              worktrees: {
                ...state.worktrees,
                [requestId]: {
                  workspaceId: workspace.id,
                  projectId,
                  requestId,
                  path: info.status === "ready" ? info.root : workspace.cwd,
                  prefix: info.status === "ready" ? info.prefix : "",
                  commonDir: info.status === "ready" ? info.commonDir : "",
                  branch:
                    info.status === "ready" && info.head.kind !== "detached"
                      ? info.head.name
                      : "HEAD",
                  createdBranch: false,
                  baseSha:
                    info.status === "ready" && info.head.kind !== "unborn"
                      ? info.head.sha
                      : "unknown",
                  managed: false,
                  status: verified ? "ready" : "needs_reconciliation",
                  ...(verified ? {} : { reason: "无法核实该目录属于此项目的仓库" }),
                  createdAt,
                },
              },
            }));
          }
          const results: WorktreeSummary[] = [];
          for (const [requestId, receipt] of yield* receipts(projectId))
            results.push(
              summary(receipt.commonDir ? yield* settle(requestId, receipt) : receipt, requestId),
            );
          return results;
        }),
        remove: Effect.fn("WorktreeService.remove")(function* (
          workspaceId: string,
          requestId: string,
        ) {
          const state = yield* store.read;
          const entry = Object.entries(state.worktrees ?? {}).find(
            ([, receipt]) => receipt.workspaceId === workspaceId,
          );
          if (!entry)
            return yield* new CoreError({
              code: "InvalidInput",
              message: "只能移除由 Eta 创建的 worktree",
            });
          const [key, savedReceipt] = entry;
          let receipt = savedReceipt;
          const known = state.requests?.[requestId];
          const print = fingerprint({ op: "remove", workspaceId });
          if (known && known !== print)
            return yield* new CoreError({
              code: "InvalidInput",
              message: "该请求 ID 已用于不同的参数",
            });
          if (receipt.status === "removed") return summary(receipt, key);
          if (!receipt.managed)
            return yield* new CoreError({
              code: "InvalidInput",
              message: "该 worktree 不是由 Eta 创建的，请在 Git 中自行移除",
            });
          const release = yield* Effect.sync(() =>
            access.reserveRemoval(join(receipt.path, receipt.prefix)),
          );
          yield* Effect.addFinalizer(() => Effect.sync(release));
          if (yield* busy(workspaceId))
            return yield* new CoreError({ code: "Busy", message: "请先停止该工作区中的任务" });
          const info = yield* Effect.promise(() => inspectRepository(receipt.path, workspaceId));
          if (info.status === "ready") {
            if (!info.linkedWorktree || info.commonDir !== receipt.commonDir)
              return yield* new CoreError({
                code: "WorkspaceUnavailable",
                message: "工作区的 Git 身份已变更，请先核对工作区",
              });
            if (info.head.kind !== "branch")
              return yield* new CoreError({
                code: "InvalidInput",
                message: "请先创建分支保留当前提交，再移除工作区",
              });
            receipt = { ...receipt, branch: info.head.name };
            const { staged, unstaged, untracked, conflicted } = info.changes;
            if (staged + unstaged + untracked + conflicted > 0 || info.operation)
              return yield* new CoreError({
                code: "InvalidInput",
                message: "工作区还有未提交或未跟踪的改动，请先提交或处理后再移除",
              });
            if (yield* Effect.promise(() => exists(join(receipt.path, ".gitmodules"))))
              return yield* new CoreError({
                code: "InvalidInput",
                message: "暂不支持移除包含 submodule 的 worktree",
              });
          }
          yield* store.update((current) => ({
            ...current,
            requests: { ...current.requests, [requestId]: print },
            worktrees: { ...current.worktrees, [key]: { ...receipt, status: "removing" } },
          }));
          yield* adapter(
            "无法移除 worktree",
            () =>
              withRepositoryLock(receipt.commonDir, async () => {
                if (await exists(receipt.path))
                  // Never forced: Git refuses dirty or locked worktrees and Eta reports that instead.
                  await git(
                    receipt.commonDir,
                    ["worktree", "remove", receipt.path],
                    "无法移除 worktree",
                  );
                else await forgetWorktree(receipt.commonDir, receipt.path);
              }),
            "WorkspaceUnavailable",
          ).pipe(Effect.tapError(() => save(key, (current) => ({ ...current, status: "ready" }))));
          const removedAt = yield* now;
          // The workspace stays in the Catalog as a tombstone so its threads remain readable.
          yield* save(key, (current) => ({ ...current, status: "removed", removedAt }));
          for (const thread of (yield* catalog.read).threads.filter(
            (value) => value.workspaceId === workspaceId,
          )) {
            const runtime = yield* registry.peek(thread.sessionRef);
            if (runtime) {
              runtime.blockedReason = "工作区已移除，历史仍可查看；请从保留分支开始新会话";
              for (const notify of runtime.changes) notify();
            }
          }
          return summary({ ...receipt, status: "removed", removedAt }, key);
        }, Effect.scoped),
      });
    }),
  );
}
