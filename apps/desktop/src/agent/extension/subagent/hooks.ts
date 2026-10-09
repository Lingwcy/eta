import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, GenerationTask, ToolTask, ROOT_CONVERSATION_ID, hook } from "@eta/agent";
import type { ConversationId } from "@eta/agent";
import { SubagentsDoc, isDescendant } from "./state.ts";
import type { SubagentRuntime } from "./runtime.ts";

export function createSubagentHooks({
  options,
  settings,
  modelScope,
  state,
  commit,
  gate,
}: SubagentRuntime) {
  const waitUnpaused = async (id: ConversationId, context: Context) => {
    const ready = async () => {
      const doc = await state(context);
      return (
        options.ready?.() !== false &&
        !doc?.stopping &&
        !doc?.agents.find((child) => child.conversationId === id)?.paused
      );
    };
    if (!(await ready())) await gate(ready, context);
  };
  return [
    hook(GenerationTask, {
      onYield: async (_answer, api, context) => {
        const descendants = async () => {
          const doc = await state(context);
          const self = doc?.agents.find((child) => child.conversationId === api.conversationId);
          return (doc?.agents ?? []).filter(
            (child) =>
              api.conversationId === ROOT_CONVERSATION_ID ||
              (self && isDescendant(child, self.path, doc!.agents)),
          );
        };
        const unfinished = async () =>
          (await descendants()).some(
            (child) => child.active.length || child.pending.length || child.settling?.length,
          );
        const continuation = {
          continue: "子任务已收尾，请汇总回传结果；若全部停止或失败，请说明情况。",
          continueQueued: true,
        };
        if (api.conversationId === ROOT_CONVERSATION_ID && (await unfinished())) return undefined;
        if (!(await unfinished())) {
          const queued = (await options.harness().inspect(context)).submissions.some(
            (receipt) =>
              receipt.conversationId === api.conversationId &&
              receipt.status === "queued" &&
              receipt.requestId?.startsWith("subagent-report:"),
          );
          return queued ? continuation : undefined;
        }
        await commit(
          api.conversationId,
          async (tx) => {
            const doc = await tx.doc(SubagentsDoc);
            doc.waiters ??= [];
            if (!doc.waiters.some((waiter) => waiter.taskId === api.taskId))
              doc.waiters.push({ conversationId: api.conversationId, taskId: api.taskId });
          },
          context,
        );
        try {
          await gate(async () => !(await unfinished()), context);
          return continuation;
        } finally {
          await commit(
            api.conversationId,
            async (tx) => {
              const doc = await tx.doc(SubagentsDoc);
              doc.waiters = doc.waiters?.filter((waiter) => waiter.taskId !== api.taskId);
            },
            BACKGROUND_CONTEXT,
          ).catch(() => {});
        }
      },
      beforeRequest: async (_request, api, context) => {
        await waitUnpaused(api.conversationId, context);
        if (api.conversationId !== ROOT_CONVERSATION_ID) {
          const policy = await settings();
          const allowedModels = await modelScope(policy, context);
          const agent = await api.snapshot(AgentDoc, api.conversationId, context);
          const model = agent?.model;
          if (
            !model ||
            !allowedModels.some(
              (allowed) => allowed.provider === model.provider && allowed.modelId === model.modelId,
            ) ||
            !(await options.available(model.provider, model.modelId))
          ) {
            await commit(
              api.conversationId,
              async (tx) => {
                const child = (await tx.doc(SubagentsDoc)).agents.find(
                  (child) => child.conversationId === api.conversationId,
                );
                if (child) {
                  child.status = "failed";
                  child.error = "子智能体模型已不可用或不在允许范围内";
                }
              },
              context,
            );
            // Generation hooks report ordinary throws; cancellation is required to prevent the request.
            await options.harness().abortTask(api.taskId, context);
            throw context.abortSignal?.reason ?? new Error("子智能体模型不可用");
          }
        }
      },
    }),
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        await waitUnpaused(api.conversationId, context);
        const policy = await settings();
        if (
          api.conversationId === ROOT_CONVERSATION_ID &&
          policy.enabled !== false &&
          policy.mode === "orchestrator" &&
          call.name !== "subagent"
        )
          return { block: "Orchestrator mode: delegate execution with the subagent tool." };
        return undefined;
      },
    }),
  ];
}
