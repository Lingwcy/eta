import type { ThinkingLevel } from "../../../agent/protocol.ts";
import { imageInput } from "../../../images/content.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type, clampThinkingLevel } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  AgentDoc,
  GenerationTask,
  ToolTask,
  ROOT_CONVERSATION_ID,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  section,
} from "@eta/agent";
import type { ConversationId, EntryId, Harness, TaskId, Tx } from "@eta/agent";
import { defaultSubagentSettings } from "../../../subagents.ts";
import type { SubagentCommand, SubagentSettings, SubagentSummary } from "../../../subagents.ts";
import { DesktopServiceError } from "../errors.ts";

// Session scope separates the execution tree from transcript ancestry, including independent children.
type Child = {
  path: string;
  parent: string;
  conversationId: ConversationId;
  depth: number;
  fork: boolean;
  paused: boolean;
  active: TaskId[];
  pending: TaskId[];
  settling?: TaskId[];
  reported: EntryId[];
  status: SubagentSummary["status"];
  model: { provider: string; modelId: string };
  error?: string;
};
export const SubagentsDoc = defineDoc<{
  stopping: boolean;
  revision: number;
  agents: Child[];
  requests: Record<string, string>;
  waiters?: { conversationId: ConversationId; taskId: TaskId }[];
}>({
  kind: "eta.subagents",
  version: 1,
  scope: "session",
  initial: () => ({ stopping: false, revision: 0, agents: [], requests: {} }),
});

const invalid = (message: string): never => {
  throw new DesktopServiceError({ code: "InvalidInput", message });
};
export function childPath(parent: string, name: string, fork: boolean) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) invalid("智能体名称只能包含字母、数字、下划线和连字符");
  if (!fork && name === "root") invalid("/root 保留给主智能体");
  return fork ? `${parent}/${name}` : `/${name}`;
}

export function createSubagentsExtension(options: {
  harness: () => Harness;
  settings: () => Promise<SubagentSettings | undefined>;
  available: (provider: string, modelId: string) => Promise<boolean>;
  clamp: (
    model: { provider: string; modelId: string },
    level: ThinkingLevel,
  ) => ReturnType<typeof clampThinkingLevel>;
  instructions: () => Promise<string>;
  maximumImages?: (model: { provider: string; modelId: string }) => number | undefined;
}) {
  const settings = async () => (await options.settings()) ?? defaultSubagentSettings;
  const modelScope = async (policy: SubagentSettings, context: Context) => {
    if (policy.allowedModels?.length) return policy.allowedModels;
    const root = await options.harness().snapshot(AgentDoc, ROOT_CONVERSATION_ID, context);
    return root?.model ? [root.model] : [];
  };
  const state = (context: Context) => options.harness().snapshot(SubagentsDoc, context);
  const commit = <T>(actor: ConversationId, change: (tx: Tx) => T | Promise<T>, context: Context) =>
    options
      .harness()
      .conversation(actor, context)
      .then((conversation) => {
        if (!conversation) return invalid("智能体会话不存在");
        return conversation.commit(change, context);
      });

  // Gates wait on persisted document changes and release on cancellation; restart retries the durable phase.
  const gate = async (test: () => Promise<boolean>, context: Context) => {
    const watch = await options.harness().watchDoc(SubagentsDoc, context);
    if (!watch) return invalid("子智能体状态不存在");
    let cleanup: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let checking = false;
        let again = false;
        const check = async () => {
          again = true;
          if (checking) return;
          checking = true;
          try {
            while (again) {
              again = false;
              if (await test()) {
                resolve();
                break;
              }
            }
          } catch (error) {
            reject(error);
          } finally {
            checking = false;
          }
        };
        const abort = () => reject(context.abortSignal?.reason ?? new Error("Cancelled"));
        context.abortSignal?.addEventListener("abort", abort, { once: true });
        if (context.abortSignal?.aborted) abort();
        watch.start(check);
        void check();
        // Remove the listener on both resolution and cancellation, below.
        cleanup = () => context.abortSignal?.removeEventListener("abort", abort);
      });
    } finally {
      cleanup?.();
      await watch.stop();
    }
  };

  const Anchor = defineTask<null, { phase: "done" }, null>({
    name: "eta.subagent-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: (_task, runtime, context) =>
        runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        ),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  type Input = {
    path: string;
    message: string;
    images?: { type: "image"; data: string; mimeType: string; name?: string; note?: string }[];
  };
  type State =
    | { phase: "deliver" }
    | { phase: "join"; answer: EntryId }
    | { phase: "report"; report?: string };
  const Reporter = defineTask<Input, State, null>({
    name: "eta.subagent-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, context) => {
        try {
          await gate(async () => {
            const policy = await settings();
            return commit(
              runtime.conversationId,
              async (tx) => {
                const doc = await tx.doc(SubagentsDoc);
                const child = doc.agents.find((agent) => agent.path === task.input.path)!;
                if (doc.stopping || child.paused) return false;
                if (child.active.includes(task.id)) return true;
                if (
                  child.active.length === 0 &&
                  doc.agents.filter(
                    (agent) =>
                      agent.active.length > 0 &&
                      !doc.waiters?.some(
                        (waiter) => waiter.conversationId === agent.conversationId,
                      ),
                  ).length >= policy.maxConcurrent
                )
                  return false;
                child.active.push(task.id);
                child.pending = child.pending.filter((id) => id !== task.id);
                child.status = "running";
                return true;
              },
              context,
            );
          }, context);
          const child = (await state(context))!.agents.find(
            (agent) => agent.path === task.input.path,
          )!;
          const conversation = (await runtime.conversation(child.conversationId, context))!;
          const submission = await conversation.submit(
            {
              type: "input",
              content: imageInput(task.input.message, task.input.images),
              whenBusy: "steer",
              requestId: `subagent:${task.id}`,
            },
            context,
          );
          const result = await submission.wait(context);
          await runtime.commit(async (tx) => {
            const record = (await tx.doc(SubagentsDoc)).agents.find(
              (agent) => agent.path === child.path,
            )!;
            record.active = record.active.filter((id) => id !== task.id);
            let report: string | undefined;
            if (result.status === "unanswered") {
              record.status = result.reason === "aborted" && !record.error ? "stopped" : "failed";
              if (result.reason !== "aborted" || record.error) {
                record.error ??= typeof result.detail === "string" ? result.detail : result.reason;
                report = `[${child.path} failed] ${record.error}`;
              }
            } else if (result.type === "input") {
              // Waiting for descendants must not reserve an execution slot: they may be queued behind us.
              record.settling ??= [];
              record.settling.push(task.id);
              record.status = "running";
              return {
                status: "running",
                checkpoint: { phase: "join", answer: result.answer },
              };
            }
            if (report) {
              record.settling ??= [];
              record.settling.push(task.id);
            }
            return {
              status: "running",
              checkpoint: { phase: "report", ...(report ? { report } : {}) },
            };
          }, context);
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          await runtime.commit(async (tx) => {
            const child = (await tx.doc(SubagentsDoc)).agents.find(
              (child) => child.path === task.input.path,
            )!;
            child.active = child.active.filter((id) => id !== task.id);
            child.pending = child.pending.filter((id) => id !== task.id);
            child.status = "failed";
            child.settling ??= [];
            if (!child.settling.includes(task.id)) child.settling.push(task.id);
            child.error = error instanceof Error ? error.message : "子智能体执行失败";
            return {
              status: "running",
              checkpoint: { phase: "report", report: `[${child.path} failed] ${child.error}` },
            };
          }, context);
        }
      },
      join: async (task, runtime, context) => {
        await gate(async () => {
          const doc = (await state(context))!;
          return !doc.agents.some(
            (child) =>
              isDescendant(child, task.input.path, doc.agents) &&
              (child.active.length || child.pending.length || child.settling?.length),
          );
        }, context);
        const child = (await state(context))!.agents.find(
          (child) => child.path === task.input.path,
        )!;
        const conversation = (await runtime.conversation(child.conversationId, context))!;
        await conversation.waitForIdle(context);
        await runtime.commit(async (tx) => {
          const record = (await tx.doc(SubagentsDoc)).agents.find(
            (child) => child.path === task.input.path,
          )!;
          let report: string | undefined;
          if (!record.reported.includes(task.state.checkpoint.answer)) {
            record.reported.push(task.state.checkpoint.answer);
            // Descendant reports can produce a newer synthesis than the original answer.
            const latest = (await tx.scanEntries({ conversationId: child.conversationId }, 1))
              .items[0];
            const answer =
              latest && AssistantEntry.is(latest)
                ? latest
                : await tx.entry(AssistantEntry, task.state.checkpoint.answer);
            const text =
              answer?.model
                ?.flatMap((message) =>
                  message.role === "assistant"
                    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                    : [],
                )
                .join("\n") ?? "";
            report = `[${child.path} completed] ${text}`;
          }
          record.status = record.active.length
            ? "running"
            : record.pending.length
              ? "queued"
              : "completed";
          return {
            status: "running",
            checkpoint: { phase: "report", ...(report ? { report } : {}) },
          };
        }, context);
      },
      report: async (task, runtime, context) => {
        if (task.state.checkpoint.report) {
          const parent = (await runtime.conversation(runtime.conversationId, context))!;
          await parent.submit(
            {
              type: "input",
              content: task.state.checkpoint.report,
              whenBusy: "steer",
              requestId: `subagent-report:${task.id}`,
            },
            context,
          );
        }
        await runtime.commit(async (tx) => {
          const child = (await tx.doc(SubagentsDoc)).agents.find(
            (child) => child.path === task.input.path,
          )!;
          child.settling = child.settling?.filter((id) => id !== task.id);
          if (child.status !== "failed" && child.status !== "stopped")
            child.status =
              child.active.length || child.settling?.length
                ? "running"
                : child.pending.length
                  ? "queued"
                  : "completed";
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const child = (await tx.doc(SubagentsDoc)).agents.find(
          (agent) => agent.path === task.input.path,
        );
        if (child) {
          child.active = child.active.filter((id) => id !== task.id);
          child.pending = child.pending.filter((id) => id !== task.id);
          child.settling = child.settling?.filter((id) => id !== task.id);
          if (!child.active.length && !child.pending.length && !child.settling?.length)
            child.status = "stopped";
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });

  const execute = async (
    command: SubagentCommand,
    actor: ConversationId,
    requestId: string,
    context = BACKGROUND_CONTEXT,
  ) => {
    const policy = await settings();
    const current = await state(context);
    if ((command.action === "spawn" || command.action === "send") && current?.requests[requestId])
      return `Sent to ${current.requests[requestId]}`;
    const self = current?.agents.find((agent) => agent.conversationId === actor);
    const actorPath = self?.path ?? "/root";
    const parentPath = command.parent ?? actorPath;
    if (parentPath !== actorPath) invalid("只能从当前智能体创建子智能体");
    if (command.action === "list") return "Listed subagents";
    if (command.action === "pause" || command.action === "resume") {
      await commit(
        actor,
        async (tx) => {
          const child = (await tx.doc(SubagentsDoc)).agents.find(
            (agent) => agent.path === command.path,
          );
          if (!child) return invalid("子智能体不存在");
          child.paused = command.action === "pause";
        },
        context,
      );
      return command.action === "pause" ? "将在下一次模型请求或工具调用前暂停" : "已恢复";
    }
    if (command.action === "stop") {
      const child = current?.agents.find((agent) => agent.path === command.path);
      if (!child) return invalid("子智能体不存在");
      const stopped = new Set<string>();
      while (true) {
        const latest = (await state(context))!.agents;
        const target = latest.find(
          (agent) =>
            !stopped.has(agent.path) &&
            (agent.path === child.path || isDescendant(agent, child.path, latest)),
        );
        if (!target) break;
        stopped.add(target.path);
        await commit(
          actor,
          async (tx) => {
            const record = (await tx.doc(SubagentsDoc)).agents.find(
              (agent) => agent.path === target.path,
            )!;
            record.paused = false;
            delete record.error;
          },
          context,
        );
        for (const id of [...target.active, ...target.pending, ...(target.settling ?? [])])
          await options.harness().abortTask(id, context);
        await (await options.harness().conversation(target.conversationId, context))!.abort(
          context,
          { background: true },
        );
      }
      return "已停止";
    }
    if (current?.stopping) invalid("会话正在停止任务");
    if (!command.message?.trim() && !command.images?.length) invalid("请提供子智能体任务或消息");
    imageInput(command.message ?? "", command.images);
    const preset = command.preset
      ? policy.presets.find((preset) => preset.name === command.preset)
      : undefined;
    if (command.preset && !preset) invalid("智能体预设不存在");
    const parent = (await options.harness().conversation(actor, context))!;
    const parentAgent = await parent.agent(context);
    let selected = command.model;
    if (command.action === "spawn") {
      const candidates = command.model
        ? [command.model]
        : preset?.models.length
          ? preset.models
          : parentAgent.model
            ? [parentAgent.model]
            : [];
      selected = undefined;
      const allowedModels = await modelScope(policy, context);
      for (const model of candidates) {
        if (
          !allowedModels.some(
            (allowed) => allowed.provider === model.provider && allowed.modelId === model.modelId,
          )
        )
          continue;
        if (await options.available(model.provider, model.modelId)) {
          selected = model;
          break;
        }
      }
      if (!selected) invalid("没有已启用且获准使用的候选模型");
    }
    const targetModel =
      selected ?? current?.agents.find((child) => child.path === command.path)?.model;
    const maximum = targetModel && options.maximumImages?.(targetModel);
    if (maximum && command.images && command.images.length > maximum)
      invalid(`当前模型每条消息最多支持 ${maximum} 张图片`);
    const instructions = command.action === "spawn" ? await options.instructions() : "";
    const path = await commit(
      actor,
      async (tx) => {
        const doc = await tx.doc(SubagentsDoc);
        if (doc.stopping) invalid("会话正在停止任务");
        if (doc.requests[requestId]) return doc.requests[requestId]!;
        let child = doc.agents.find((agent) => agent.path === command.path);
        if (command.action === "spawn") {
          const depth = (self?.depth ?? 0) + 1;
          if (depth > policy.maxDepth) invalid("已达到子智能体嵌套深度上限");
          const path = childPath(
            parentPath,
            command.name ?? preset?.name ?? `task-${doc.agents.length + 1}`,
            command.fork === true,
          );
          if (doc.agents.some((agent) => agent.path === path)) invalid("智能体名称已存在");
          const at = command.fork
            ? (await tx.scanEntries({ conversationId: actor }, 1)).items[0]?.id
            : undefined;
          if (command.fork && !at) invalid("当前对话没有可分叉的历史");
          const anchor = await tx.createTask(Anchor, null, {
            ownership: { kind: "conversation" },
            background: true,
          });
          const ownership = { kind: "task", taskId: anchor } as const;
          const created = at
            ? await tx.forkConversation(actor, at, { ownership })
            : await tx.createConversation({ ownership });
          const level = options.clamp(
            selected!,
            command.thinkingLevel ?? preset?.thinkingLevel ?? parentAgent.thinkingLevel,
          );
          await configure(tx, created.id, {
            model: selected!,
            thinkingLevel: level === "off" ? null : level,
            tools: null,
            instructions: `${instructions}\nYou are ${path}. ${preset?.instructions ?? "Complete the assigned task and report the result."}`,
          });
          child = {
            path,
            parent: parentPath,
            conversationId: created.id,
            depth,
            fork: Boolean(at),
            paused: false,
            active: [],
            pending: [],
            reported: [],
            status: "queued",
            model: selected!,
          };
          doc.agents.push(child);
          child = doc.agents[doc.agents.length - 1]!;
        }
        if (!child) return invalid("子智能体不存在");
        const reporter = await tx.createTask(
          Reporter,
          {
            path: child.path,
            message: command.message ?? "",
            ...(command.images?.length ? { images: [...command.images] } : {}),
          },
          { ownership: { kind: "conversation" }, background: true },
        );
        child.pending.push(reporter);
        if (!child.active.length) child.status = "queued";
        delete child.error;
        doc.requests[requestId] = child.path;
        return child.path;
      },
      context,
    );
    return `Sent to ${path}`;
  };
  const tool = defineTool({
    name: "subagent",
    description:
      "Manage durable background agents. spawn: name, message, fork (true inherits history; false starts independently), optional preset, model and thinkingLevel. send continues a child after its current task ends. list, pause, resume and stop accept path. Reports arrive automatically after all descendants finish. Continue coordinating while children work. Your turn stays running while waiting for their reports; summarize after they finish.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("spawn"),
        Type.Literal("send"),
        Type.Literal("list"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("stop"),
      ]),
      name: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      fork: Type.Optional(Type.Boolean()),
      preset: Type.Optional(Type.String()),
      model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
      thinkingLevel: Type.Optional(
        Type.Union([
          Type.Literal("off"),
          Type.Literal("minimal"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
          Type.Literal("max"),
        ]),
      ),
    }),
    replay: "safe",
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const text = await execute(args, api.conversationId, `tool:${api.taskId}`, context);
      return {
        content: [
          {
            type: "text",
            text: args.action === "list" ? JSON.stringify(await list(context)) : text,
          },
        ],
      };
    },
  });
  const list = async (context = BACKGROUND_CONTEXT): Promise<SubagentSummary[]> => {
    const doc = await state(context);
    return (doc?.agents ?? []).map((child) => ({
      path: child.path,
      parent: child.parent,
      conversationId: child.conversationId,
      depth: child.depth,
      fork: child.fork,
      status: child.paused ? "paused" : child.status,
      model: child.model,
      ...(child.error ? { error: child.error } : {}),
    }));
  };
  const waitUnpaused = async (id: ConversationId, context: Context) => {
    const ready = async () => {
      const doc = await state(context);
      return !doc?.stopping && !doc?.agents.find((child) => child.conversationId === id)?.paused;
    };
    if (!(await ready())) await gate(ready, context);
  };
  const extension = defineExtension({
    name: "desktop-subagents",
    tasks: [Anchor, Reporter],
    tools: [tool],
    sections: [
      section("subagents", async (input, context) => {
        const policy = await settings();
        const doc = await input.read.snapshot(SubagentsDoc, context);
        const child = doc?.agents.find((child) => child.conversationId === input.conversationId);
        const unfinished = (doc?.agents ?? [])
          .filter(
            (candidate) =>
              (!child || isDescendant(candidate, child.path, doc!.agents)) &&
              ["running", "queued", "paused"].includes(candidate.status),
          )
          .map((candidate) => candidate.path);
        const allowedModels = await modelScope(policy, context);
        return `You are ${child?.path ?? "/root"}. Max nesting depth: ${policy.maxDepth}; concurrent children: ${policy.maxConcurrent}. ${!child && policy.mode === "orchestrator" ? "Delegate all implementation, research and command execution to subagents. Coordinate and synthesize results; keep the task running until all delegated work is settled. Use only the subagent tool." : "Delegate when useful."}\nUnfinished delegated tasks: ${JSON.stringify(unfinished)}. While any remain, give only interim updates; do not claim the overall task is complete.\nPresets: ${JSON.stringify(policy.presets)}\nEnabled subagent models: ${JSON.stringify(allowedModels)}`;
      }),
    ],
    hooks: [
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
                (allowed) =>
                  allowed.provider === model.provider && allowed.modelId === model.modelId,
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
          if (
            api.conversationId === ROOT_CONVERSATION_ID &&
            (await settings()).mode === "orchestrator" &&
            call.name !== "subagent"
          )
            return { block: "Orchestrator mode: delegate execution with the subagent tool." };
          return undefined;
        },
      }),
    ],
  });
  const stopAll = async () => {
    await commit(
      ROOT_CONVERSATION_ID,
      async (tx) => {
        (await tx.doc(SubagentsDoc)).stopping = true;
      },
      BACKGROUND_CONTEXT,
    );
    try {
      await (await options.harness().conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))!.abort(
        BACKGROUND_CONTEXT,
        { background: true },
      );
      const doc = await state(BACKGROUND_CONTEXT);
      for (const child of doc?.agents.filter((child) => child.parent === "/root") ?? [])
        await execute(
          { action: "stop", path: child.path },
          ROOT_CONVERSATION_ID,
          `stop:${child.path}`,
        );
    } finally {
      await commit(
        ROOT_CONVERSATION_ID,
        async (tx) => {
          (await tx.doc(SubagentsDoc)).stopping = false;
        },
        BACKGROUND_CONTEXT,
      );
    }
  };
  return { extension, tool, execute, list, stopAll };
}

function isDescendant(child: Child, parent: string, agents: Child[]): boolean {
  let cursor = child.parent;
  const seen = new Set<string>();
  while (cursor !== "/root" && !seen.has(cursor)) {
    if (cursor === parent) return true;
    seen.add(cursor);
    cursor = agents.find((agent) => agent.path === cursor)?.parent ?? "/root";
  }
  return false;
}
