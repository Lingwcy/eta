import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineTask, hook, ToolTask } from "@eta/agent";
import type { ConversationId, Harness, JsonObject, TaskId, Tx } from "@eta/agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import type { SandboxApproval } from "../../shared/sandbox.ts";
import { SandboxDoc } from "./sandbox.ts";
import { canonicalRoot } from "../../platform/sandbox/backend.ts";
import { CoreError } from "../errors.ts";

type Approval = {
  -readonly [
    K in keyof Omit<SandboxApproval, "args" | "readableRoots" | "writableRoots">
  ]: SandboxApproval[K];
} & { args: JsonObject; taskId: TaskId; readableRoots: string[]; writableRoots: string[] };
export const ApprovalsDoc = defineDoc<{ requests: Approval[] }>({
  kind: "eta.sandbox-approvals",
  version: 1,
  scope: "session",
  initial: () => ({ requests: [] }),
});
const Access = Schema.Struct({
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
) {
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
    let reason = "";
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
        networkAccess = mode === "read-only" && requested.networkAccess === true;
        for (const path of [...readableRoots, ...writableRoots]) assertUnprotected(path);
        if (networkAccess || readableRoots.length || writableRoots.length)
          reason = requested.reason;
      }
    }
    return reason
      ? {
          reason,
          readableRoots: [...new Set(readableRoots)],
          writableRoots: [...new Set(writableRoots)],
          networkAccess,
        }
      : undefined;
  };
  return {
    extension: {
      name: "eta-sandbox-approvals",
      tasks: [task],
      hooks: [
        hook(ToolTask, {
          authorizeTool: async (call, api, context) => {
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
                return { block: "此操作未获批准" };
              if (previous.status === "pending") return { waitFor: previous.taskId };
            }
            const id = randomUUID();
            let taskId: TaskId | undefined;
            await commit(
              api.conversationId,
              async (tx) => {
                const doc = await tx.doc(ApprovalsDoc);
                taskId = await tx.createTask(
                  task,
                  { requestId: id },
                  { ownership: { kind: "task", taskId: api.taskId } },
                );
                doc.requests.push({
                  id,
                  taskId,
                  toolTaskId: String(api.taskId),
                  conversationId: String(api.conversationId),
                  tool: call.name,
                  args: call.arguments as JsonObject,
                  mode,
                  revision: sandbox?.revision ?? 0,
                  status: "pending",
                  ...scope,
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
      (await harness().snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))?.requests.filter(
        (request) => request.status === "pending",
      ) ?? [],
    invalidate: async (conversationId: ConversationId) => {
      await commit(
        conversationId,
        async (tx) => {
          const doc = await tx.doc(ApprovalsDoc);
          for (const request of doc.requests)
            if (request.status === "approved") request.status = "cancelled";
        },
        BACKGROUND_CONTEXT,
      );
    },
    decide: async (conversationId: ConversationId, id: string, approved: boolean) => {
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
        },
        BACKGROUND_CONTEXT,
      );
    },
  };
}
