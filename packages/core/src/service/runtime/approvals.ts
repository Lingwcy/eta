import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask, hook, LiveDoc, ROOT_CONVERSATION_ID, ToolTask } from "@eta/agent";
import type { ConversationId, Harness, JsonObject, TaskId, Tx } from "@eta/agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import type { SandboxApproval } from "../../shared/sandbox.ts";
import { SandboxDoc } from "./sandbox.ts";
import { canonicalRoot } from "../../platform/sandbox/backend.ts";
import { CoreError } from "../errors.ts";
import { ApprovalsDoc } from "./approval-doc.ts";
import { activeRootRun, runGrant } from "./approval-doc.ts";
import type { Approval } from "./approval-doc.ts";
import { createReviewTask } from "./review.ts";
import { gitMetadataScope } from "../git/metadata.ts";
import type { GitMetadataScope } from "../git/metadata.ts";
import type { ReviewOptions } from "./review.ts";
import { defaultApprovalReviewerMode } from "../../shared/runtime-settings.ts";

export { ApprovalsDoc } from "./approval-doc.ts";

const sameRoots = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

const publicApproval = ({ rootRunId: _rootRunId, ...request }: Approval) => request;

/** Consecutive automatic denials in one conversation before review hands every request to the user. */
export const REVIEW_DENIAL_LIMIT = 3;

const Access = Schema.Struct({
  gitMetadata: Schema.optionalKey(Schema.Boolean),
  networkAccess: Schema.optionalKey(Schema.Boolean),
  readableRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  writableRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  reason: Schema.NonEmptyString,
});
const contains = (root: string, path: string) => {
  const suffix = relative(root, path);
  return (
    suffix !== ".." &&
    !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(suffix)
  );
};

export function createSandboxApprovals(
  harness: () => Harness,
  workspaceRoot: string,
  release: (taskId: string) => Promise<void>,
  deniedRoots: readonly string[] = [],
  review?: ReviewOptions,
) {
  const reviewTask = review && createReviewTask(review);
  const commit = async (
    conversationId: ConversationId,
    change: (tx: Tx) => Promise<void>,
    context: Context,
  ) => {
    const conversation = await harness().conversation(conversationId, context);
    if (!conversation) throw new Error("审批会话不存在");
    return conversation.commit(change, context);
  };
  const task = defineTask<{ requestId: string }, { phase: "decision" }, boolean>({
    name: "eta.sandbox-approval",
    version: 1,
    initial: () => ({ phase: "decision" }),
    phases: {
      decision: async (task, runtime, context) => {
        const watch = await runtime.watchDoc(ApprovalsDoc, context);
        if (!watch) throw new Error("审批状态不存在");
        let cleanup: (() => void) | undefined;
        try {
          const status = await new Promise<Approval["status"]>((resolve, reject) => {
            const check = async () => {
              const state = await runtime.snapshot(ApprovalsDoc, context);
              const request = state?.requests.find(
                (request) => request.id === task.input.requestId,
              );
              if (!request || request.status !== "pending") resolve(request?.status ?? "cancelled");
            };
            const abort = () => reject(runtime.signal.reason ?? new Error("Cancelled"));
            runtime.signal.addEventListener("abort", abort, { once: true });
            if (runtime.signal.aborted) abort();
            watch.start(async () => {
              await check().catch(reject);
            });
            void check().catch(reject);
            // The watch stops with this invocation. The abort listener is removed below.
            cleanup = () => runtime.signal.removeEventListener("abort", abort);
          });
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: status === "approved" },
            }),
            context,
          );
        } finally {
          cleanup?.();
          await watch.stop();
        }
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(ApprovalsDoc);
        const request = state.requests.find((request) => request.id === task.input.requestId);
        if (request && request.status === "pending") request.status = "cancelled";
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
  const classify = async (call: ToolCall, mode: SandboxApproval["mode"]) => {
    const readableRoots: string[] = [];
    const writableRoots: string[] = [];
    let networkAccess = false;
    let requestedNetworkAccess = false;
    let reason = "";
    let git: GitMetadataScope | undefined;
    const protectedRoots = await Promise.all(
      [
        ...deniedRoots,
        ...[".ssh", ".aws", ".azure", ".gnupg", ".codex"].map((path) => resolve(homedir(), path)),
      ].map(canonicalRoot),
    );
    const assertUnprotected = (path: string) => {
      if (protectedRoots.some((root) => contains(root, path)))
        throw new Error("沙盒禁止访问 Eta 应用数据或凭证目录，单次批准不能解除此限制");
    };
    if (["read", "write", "edit"].includes(call.name)) {
      if (typeof call.arguments.path !== "string") throw new Error("无效文件路径");
      const raw = call.arguments.path;
      const path = await canonicalRoot(
        raw.startsWith("file:")
          ? fileURLToPath(raw)
          : raw === "~"
            ? homedir()
            : raw.startsWith("~/")
              ? resolve(homedir(), raw.slice(2))
              : resolve(workspaceRoot, raw),
      );
      assertUnprotected(path);
      if (!contains(await canonicalRoot(workspaceRoot), path)) {
        reason = `需要访问工作区外的文件：${path}`;
        if (call.name === "read") readableRoots.push(path);
        else writableRoots.push(dirname(path));
      }
      if (mode === "read-only" && call.name !== "read") {
        reason ||= "只读模式下编辑文件需要批准";
        writableRoots.push(dirname(path));
      }
    }
    if (call.name === "bash") {
      if (mode === "read-only") reason = "只读模式下运行命令需要批准";
      if (call.arguments.sandbox !== undefined) {
        const requested = Schema.decodeUnknownSync(Access, { onExcessProperty: "error" })(
          call.arguments.sandbox,
        );
        readableRoots.push(
          ...(await Promise.all(
            (requested.readableRoots ?? []).map((path) =>
              canonicalRoot(resolve(workspaceRoot, path)),
            ),
          )),
        );
        writableRoots.push(
          ...(await Promise.all(
            (requested.writableRoots ?? []).map((path) =>
              canonicalRoot(resolve(workspaceRoot, path)),
            ),
          )),
        );
        requestedNetworkAccess = requested.networkAccess === true;
        networkAccess = mode === "read-only" && requestedNetworkAccess;
        for (const path of [...readableRoots, ...writableRoots]) assertUnprotected(path);
        if (requested.gitMetadata) git = await gitMetadataScope(await canonicalRoot(workspaceRoot));
        if (
          networkAccess ||
          readableRoots.length ||
          writableRoots.length ||
          git?.writableRoots.length
        )
          reason = requested.reason;
      }
    }
    if (!reason) return undefined;
    // Core-expanded Git roots are judged by the expansion itself; only hand-written roots go through the rules.
    const userOnly =
      (await requiresUser({ readableRoots, writableRoots })) || git?.requiresUser === true;
    // Reuse is limited to Core's own Git expansion, so a reused grant can never carry hand-written roots.
    const reusable =
      mode === "workspace-write" &&
      git?.description !== undefined &&
      !git.requiresUser &&
      !readableRoots.length &&
      !writableRoots.length &&
      !requestedNetworkAccess;
    return {
      reason,
      ...(reusable ? { reusable } : {}),
      readableRoots: [...new Set([...readableRoots, ...(git?.readableRoots ?? [])])],
      writableRoots: [...new Set([...writableRoots, ...(git?.writableRoots ?? [])])],
      networkAccess,
      ...(git?.description ? { gitMetadata: git.description } : {}),
      requiresUser: userOnly,
    };
  };
  /** Scopes that automatic review may never grant: Git metadata outside the workspace, or the whole home. */
  const requiresUser = async (scope: { readableRoots: string[]; writableRoots: string[] }) => {
    const home = await canonicalRoot(homedir());
    const covers = (root: string) => root === sep || contains(root, home);
    if ([...scope.readableRoots, ...scope.writableRoots].some(covers)) return true;
    const workspace = await canonicalRoot(workspaceRoot);
    for (const root of scope.writableRoots) {
      if (root.split(sep).includes(".git")) return true;
      // Workspace-write already exposes the workspace's own checkout; another repository's metadata is new reach.
      if (
        !contains(workspace, root) &&
        (await access(join(root, ".git")).then(
          () => true,
          () => false,
        ))
      )
        return true;
    }
    return false;
  };
  const reviewerMode = async () => (await review?.reviewer())?.mode ?? defaultApprovalReviewerMode;
  /** Trailing automatic denials since the conversation's last other decision. */
  const denialStreak = (requests: readonly Approval[], conversationId: string) => {
    let streak = 0;
    for (const request of requests.toReversed()) {
      if (request.conversationId !== conversationId || request.status === "pending") continue;
      if (request.status !== "denied" || request.decidedBy !== "auto") break;
      streak++;
    }
    return streak;
  };
  return {
    extension: {
      name: "eta-sandbox-approvals",
      tasks: reviewTask ? [task, reviewTask] : [task],
      hooks: [
        hook(ToolTask, {
          authorizeTool: async (call, api, context) => {
            const rootRunId = (await api.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run
              ?.inputs[0];
            const sandbox = await api.snapshot(SandboxDoc, context);
            if (sandbox?.mode === "danger-full-access") return;
            const mode = sandbox?.mode ?? "workspace-write";
            const scope = await classify(call, mode);
            if (!scope) return;
            const state = await api.snapshot(ApprovalsDoc, context);
            const previous = state?.requests.findLast(
              (request) => request.toolTaskId === String(api.taskId),
            );
            if (
              previous &&
              previous.revision === sandbox?.revision &&
              JSON.stringify(previous.args) === JSON.stringify(call.arguments)
            ) {
              if (previous.status === "approved") return;
              if (previous.status === "denied" || previous.status === "cancelled")
                return {
                  block:
                    previous.decidedBy === "auto" && previous.review?.rationale
                      ? `此操作未获自动审查批准：${previous.review.rationale}`
                      : "此操作未获批准",
                };
              if (previous.status === "pending") return { waitFor: previous.taskId };
            }
            const { requiresUser: userOnly, reusable, ...fields } = scope;
            const grant = {
              ...fields,
              ...(reusable && rootRunId !== undefined ? { reusable: true } : {}),
            };
            const automatic = reviewTask && (await reviewerMode()) === "auto";
            const checkAdmission = async (tx: Tx) => {
              if (
                (await activeRootRun(tx)) !== rootRunId ||
                (await tx.doc(SandboxDoc)).revision !== (sandbox?.revision ?? 0)
              )
                throw new Error("审批请求的运行或沙盒配置已失效");
            };
            const reused =
              grant.reusable &&
              state?.runGrants?.find(
                (candidate) =>
                  candidate.conversationId === String(api.conversationId) &&
                  candidate.rootRunId === rootRunId &&
                  candidate.revision === (sandbox?.revision ?? 0) &&
                  sameRoots(candidate.readableRoots, grant.readableRoots) &&
                  sameRoots(candidate.writableRoots, grant.writableRoots) &&
                  // Switching the reviewer back to the user withdraws grants the reviewer issued.
                  (candidate.by === "user" || automatic),
              );
            if (reused) {
              await commit(
                api.conversationId,
                async (tx) => {
                  await checkAdmission(tx);
                  const doc = await tx.doc(ApprovalsDoc);
                  if (!doc.runGrants?.some((candidate) => candidate.id === reused.id))
                    throw new Error("本次运行的 Git 授权已失效");
                  doc.requests.push({
                    id: randomUUID(),
                    ...(rootRunId === undefined ? {} : { rootRunId }),
                    taskId: reused.taskId,
                    toolTaskId: String(api.taskId),
                    conversationId: String(api.conversationId),
                    tool: call.name,
                    args: call.arguments as JsonObject,
                    mode,
                    revision: sandbox?.revision ?? 0,
                    status: "approved",
                    decidedBy: "reuse",
                    reusedFrom: reused.id,
                    ...grant,
                  });
                },
                context,
              );
              return;
            }
            const id = randomUUID();
            let taskId: TaskId | undefined;
            await commit(
              api.conversationId,
              async (tx) => {
                await checkAdmission(tx);
                const doc = await tx.doc(ApprovalsDoc);
                taskId = await tx.createTask(
                  task,
                  { requestId: id },
                  { ownership: { kind: "task", taskId: api.taskId } },
                );
                const skippedReason = !automatic
                  ? undefined
                  : userOnly
                    ? ("requires-user" as const)
                    : denialStreak(doc.requests, String(api.conversationId)) >= REVIEW_DENIAL_LIMIT
                      ? ("circuit-breaker" as const)
                      : undefined;
                if (automatic && !skippedReason)
                  await tx.createTask(
                    reviewTask,
                    { requestId: id },
                    { ownership: { kind: "task", taskId } },
                  );
                doc.requests.push({
                  id,
                  ...(rootRunId === undefined ? {} : { rootRunId }),
                  taskId,
                  toolTaskId: String(api.taskId),
                  conversationId: String(api.conversationId),
                  tool: call.name,
                  args: call.arguments as JsonObject,
                  mode,
                  revision: sandbox?.revision ?? 0,
                  status: "pending",
                  ...grant,
                  ...(automatic
                    ? {
                        review: skippedReason
                          ? { status: "skipped", skippedReason }
                          : { status: "reviewing" },
                      }
                    : {}),
                });
              },
              context,
            );
            return { waitFor: taskId! };
          },
          afterTool: async (_call, _result, api, context) => {
            await release(String(api.taskId));
            await commit(
              api.conversationId,
              async (tx) => {
                const doc = await tx.doc(ApprovalsDoc);
                const request = doc.requests.findLast(
                  (request) => request.toolTaskId === String(api.taskId),
                );
                if (request?.status === "approved") request.status = "consumed";
              },
              context,
            );
          },
        }),
      ],
    },
    list: async () =>
      ((await harness().snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))?.requests ?? [])
        .filter((request) => request.status === "pending")
        .map(publicApproval),
    /** Recent decisions made without the user, so the client can show what was granted on its behalf. */
    history: async (limit = 20) =>
      ((await harness().snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))?.requests ?? [])
        .filter(
          (request) =>
            request.status !== "pending" &&
            (request.decidedBy === "auto" || request.decidedBy === "reuse"),
        )
        .slice(-limit)
        .map(publicApproval),
    invalidate: async (conversationId: ConversationId) => {
      await commit(
        conversationId,
        async (tx) => {
          const doc = await tx.doc(ApprovalsDoc);
          for (const request of doc.requests)
            if (request.status === "approved") request.status = "cancelled";
          if (doc.runGrants?.length) doc.runGrants = [];
        },
        BACKGROUND_CONTEXT,
      );
    },
    /** A late idle cleanup may retire old grants, never those of a replacement root run. */
    expireRunGrants: async (conversationId: ConversationId) => {
      await commit(
        conversationId,
        async (tx) => {
          const doc = await tx.doc(ApprovalsDoc);
          const rootRunId = await activeRootRun(tx);
          if (doc.runGrants?.length)
            doc.runGrants = doc.runGrants.filter(
              (grant) => rootRunId !== undefined && grant.rootRunId === rootRunId,
            );
        },
        BACKGROUND_CONTEXT,
      );
    },
    /** Returning to manual review permanently withdraws automatic grants, even if auto is enabled again. */
    withdrawAutoRunGrants: async (conversationId: ConversationId) => {
      if ((await reviewerMode()) === "auto") return;
      await commit(
        conversationId,
        async (tx) => {
          const doc = await tx.doc(ApprovalsDoc);
          if (doc.runGrants?.some((grant) => grant.by === "auto"))
            doc.runGrants = doc.runGrants.filter((grant) => grant.by === "user");
        },
        BACKGROUND_CONTEXT,
      );
    },
    decide: async (
      conversationId: ConversationId,
      id: string,
      approved: boolean,
      reuse: "call" | "run" = "call",
    ) => {
      let reviewed: Approval | undefined;
      await commit(
        conversationId,
        async (tx) => {
          const doc = await tx.doc(ApprovalsDoc);
          const sandbox = await tx.doc(SandboxDoc);
          const request = doc.requests.find((request) => request.id === id);
          if (!request) throw new CoreError({ code: "NotFound", message: "审批请求不存在" });
          if (request.status !== "pending" || request.revision !== sandbox.revision)
            throw new CoreError({ code: "InvalidInput", message: "审批请求已失效" });
          request.status = approved ? "approved" : "denied";
          request.decidedBy = "user";
          if (
            approved &&
            reuse === "run" &&
            request.reusable &&
            request.rootRunId !== undefined &&
            request.rootRunId === (await activeRootRun(tx))
          ) {
            request.reuse = "run";
            // Assign a new array: values pushed onto an array after assigning it are not tracked.
            doc.runGrants = [...(doc.runGrants ?? []), runGrant(request, "user")];
          }
          if (request.review) reviewed = JSON.parse(JSON.stringify(request)) as Approval;
        },
        BACKGROUND_CONTEXT,
      );
      // Final user decisions on reviewed requests are what the default-reviewer evaluation measures.
      if (reviewed?.review)
        await review
          ?.record({
            kind: "user-decision",
            at: Date.now(),
            requestId: reviewed.id,
            conversationId: reviewed.conversationId,
            approved,
            review: reviewed.review.status,
          })
          .catch(() => {});
    },
  };
}
