import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { LiveDoc, ROOT_CONVERSATION_ID, configure } from "@eta/agent";
import type { ConversationId, TaskId } from "@eta/agent";
import { imageInput } from "../../../images/content.ts";
import type { SubagentCommand, SubagentSummary } from "../../../shared/subagents.ts";
import { SubagentsDoc, childPath, isDescendant } from "./state.ts";
import type { SubagentRuntime } from "./runtime.ts";
import type { createSubagentTasks } from "./tasks.ts";
import type { createSubagentTools } from "./tools.ts";

export function createSubagentActions(
  { options, invalid, settings, modelScope, state, commit, gate, notify, visible }: SubagentRuntime,
  { Anchor, Reporter, Steering, Timeout }: ReturnType<typeof createSubagentTasks>,
  getTool: () => ReturnType<typeof createSubagentTools>["tool"],
) {
  const wait = async (
    path: string,
    actor: ConversationId,
    timeoutMs: number | undefined,
    context: Context,
  ) => {
    if (
      timeoutMs !== undefined &&
      (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3600000)
    )
      invalid("等待超时必须为 0 到 3600000 毫秒");
    const current = await state(context);
    const child = current?.agents.find((child) => child.path === path);
    if (!child || !visible(child, actor, current!.agents))
      return invalid("只能等待当前智能体的下级");
    const settled = async () => {
      const child = (await state(context))!.agents.find((child) => child.path === path)!;
      return (
        child.paused ||
        !(
          child.active.length ||
          child.pending.length ||
          child.settling?.length ||
          child.steering?.length
        )
      );
    };
    if (timeoutMs !== 0 && !(await settled())) {
      const live = await options.harness().snapshot(LiveDoc, actor, context);
      const taskId = live?.run?.taskId;
      if (taskId !== undefined)
        await commit(
          actor,
          async (tx) => {
            const doc = await tx.doc(SubagentsDoc);
            doc.waiters ??= [];
            if (!doc.waiters.some((waiter) => waiter.taskId === taskId))
              doc.waiters.push({ conversationId: actor, taskId });
          },
          context,
        );
      try {
        await gate(settled, context, timeoutMs);
      } finally {
        if (taskId !== undefined)
          await commit(
            actor,
            async (tx) => {
              const doc = await tx.doc(SubagentsDoc);
              doc.waiters = doc.waiters?.filter((waiter) => waiter.taskId !== taskId);
            },
            BACKGROUND_CONTEXT,
          );
      }
    }
    return (await list(context, actor)).find((child) => child.path === path)!;
  };

  const execute = async (
    command: SubagentCommand,
    actor: ConversationId,
    requestId: string,
    context = BACKGROUND_CONTEXT,
  ) => {
    const policy = await settings();
    const current = await state(context);
    if (
      (command.action === "spawn" || command.action === "send" || command.action === "update") &&
      current?.requests[requestId]
    )
      return `Sent to ${current.requests[requestId]}`;
    if (policy.enabled === false && (command.action === "spawn" || command.action === "send"))
      invalid("子智能体已关闭，请在设置中启用后再委派任务");
    const self = current?.agents.find((agent) => agent.conversationId === actor);
    if (
      (self?.stopping || current?.stopping) &&
      !["stop", "list", "output"].includes(command.action)
    )
      invalid("会话正在停止任务");
    const actorPath = self?.path ?? "/root";
    const parentPath = command.parent ?? actorPath;
    if (parentPath !== actorPath) invalid("只能从当前智能体创建子智能体");
    if (command.action === "list") return "Listed subagents";
    if (command.action === "update") {
      if (!self || !(self.active.length || self.pending.length || self.settling?.length))
        invalid("只有执行中的子智能体可以汇报进展");
      const message = command.message?.trim();
      if (!message || message.length > 8000) return invalid("进展消息须为 1 到 8000 个字符");
      await notify(self!, "progress", message, requestId, context);
      await commit(
        actor,
        async (tx) => {
          const doc = await tx.doc(SubagentsDoc);
          const child = doc.agents.find((agent) => agent.conversationId === actor)!;
          child.progress = { message, timestamp: Date.now() };
          doc.requests[requestId] = child.path;
        },
        context,
      );
      return "Progress saved and sent to parent";
    }
    if (command.action !== "spawn") {
      const child = current?.agents.find((agent) => agent.path === command.path);
      if (!child || !visible(child, actor, current!.agents))
        return invalid("只能管理当前智能体的下级");
      if (command.action === "wait")
        return JSON.stringify(await wait(child.path, actor, command.timeoutMs, context));
      if (command.action === "output") {
        const offset = command.offset ?? 0;
        const limit = command.limit ?? 16000;
        if (
          !Number.isInteger(offset) ||
          offset < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 32000
        )
          invalid("输出范围无效");
        const total = child.output?.length ?? 0;
        return JSON.stringify({
          path: child.path,
          status: child.paused ? "paused" : child.status,
          output: child.output?.slice(offset, offset + limit),
          offset,
          total,
          ...(offset + limit < total ? { nextOffset: offset + limit } : {}),
          progress: child.progress,
        });
      }
    }
    if (command.action === "spawn" && self?.canDelegate === false)
      invalid("当前执行智能体没有委派权限，请直接完成任务并汇报进展");
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
      await commit(
        actor,
        async (tx) => {
          const doc = await tx.doc(SubagentsDoc);
          for (const record of doc.agents) {
            if (
              record.path === child.path ||
              (isDescendant(record, child.path, doc.agents) &&
                (record.active.length ||
                  record.pending.length ||
                  record.settling?.length ||
                  record.steering?.length))
            )
              record.stopping = true;
          }
        },
        context,
      );
      while (true) {
        const latest = (await state(context))!.agents;
        const target = latest.find(
          (agent) =>
            !stopped.has(agent.path) &&
            (agent.path === child.path ||
              (isDescendant(agent, child.path, latest) && agent.stopping)),
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
        for (const id of [
          ...target.active,
          ...target.pending,
          ...(target.settling ?? []),
          ...(target.steering ?? []),
          ...(target.timeoutTask ? [target.timeoutTask] : []),
        ])
          await options.harness().abortTask(id, context);
        await (await options.harness().conversation(target.conversationId, context))!.abort(
          context,
          { background: true },
        );
        await commit(
          actor,
          async (tx) => {
            const record = (await tx.doc(SubagentsDoc)).agents.find(
              (agent) => agent.path === target.path,
            )!;
            record.status = "stopped";
          },
          context,
        );
      }
      await commit(
        actor,
        async (tx) => {
          const doc = await tx.doc(SubagentsDoc);
          for (const record of doc.agents) {
            if (record.path === child.path || isDescendant(record, child.path, doc.agents))
              delete record.stopping;
          }
        },
        context,
      );
      const stoppedChildren = (await state(context))!.agents.filter((child) =>
        stopped.has(child.path),
      );
      for (const stoppedChild of stoppedChildren.reverse()) {
        await notify(
          stoppedChild,
          "stopped",
          stoppedChild.progress?.message ??
            "Work cancelled before a final report; results are incomplete.",
          `stop:${requestId}:${stoppedChild.path}`,
          context,
        );
      }
      return "已停止";
    }
    const hasMessage = Boolean(command.message?.trim() || command.images?.length);
    const asyncTimeout =
      command.timeoutMs !== undefined &&
      (command.action === "send" ||
        command.wait === false ||
        (command.wait === undefined && policy.mode === "orchestrator"));
    if (
      asyncTimeout &&
      (command.timeoutMs! < 30000 ||
        command.timeoutMs! > 300000 ||
        !Number.isInteger(command.timeoutMs))
    )
      invalid("异步提醒超时必须为 30000 到 300000 毫秒");
    if (!hasMessage && !(command.action === "send" && asyncTimeout))
      invalid("请提供子智能体任务或消息");
    if (hasMessage) imageInput(command.message ?? "", command.images);
    const message =
      command.action === "send" && requestId.startsWith("tool:")
        ? `[Agent steering from ${actorPath}; this is not a new user request]\n${command.message ?? ""}`
        : (command.message ?? "");
    const preset = command.preset
      ? policy.presets.find((preset) => preset.name === command.preset)
      : undefined;
    if (command.preset && !preset) invalid("智能体预设不存在");
    const parent = (await options.harness().conversation(actor, context))!;
    const parentAgent = await parent.agent(context);
    let selected = command.model;
    if (command.action === "spawn") {
      const allowedModels = await modelScope(policy, context);
      const candidates = command.model
        ? [command.model]
        : preset?.models.length
          ? preset.models
          : [...(parentAgent.model ? [parentAgent.model] : []), ...allowedModels];
      selected = undefined;
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
        if (doc.agents.find((child) => child.conversationId === actor)?.stopping)
          invalid("会话正在停止任务");
        if (doc.requests[requestId]) return doc.requests[requestId]!;
        let child = doc.agents.find((agent) => agent.path === command.path);
        if (command.action === "spawn") {
          const depth = (self?.depth ?? 0) + 1;
          if (depth > policy.maxDepth) invalid("已达到子智能体嵌套深度上限");
          const path = childPath(
            parentPath,
            command.name ?? preset?.name ?? `task-${doc.agents.length + 1}`,
            command.fork === true,
            invalid,
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
            tools:
              (command.canDelegate ?? preset?.canDelegate ?? false)
                ? null
                : { remove: [getTool()] },
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
            canDelegate: command.canDelegate ?? preset?.canDelegate ?? false,
          };
          doc.agents.push(child);
          child = doc.agents[doc.agents.length - 1]!;
        }
        if (!child) return invalid("子智能体不存在");
        if (child.stopping) invalid("子智能体正在停止任务");
        if (command.action === "send") child.paused = false;
        const expected =
          child.active[0] ??
          child.pending[0] ??
          (child.status === "running" ? child.settling?.[0] : undefined);
        const armTimeout = async (expected: TaskId) => {
          if (asyncTimeout)
            child.timeoutTask = await tx.createTask(
              Timeout,
              { path: child.path, expected, deadline: Date.now() + command.timeoutMs! },
              { ownership: { kind: "conversation" }, background: true },
            );
        };
        if (!hasMessage) {
          if (expected === undefined) return invalid("子智能体当前没有执行中的任务");
          await armTimeout(expected);
          doc.requests[requestId] = child.path;
          return child.path;
        }
        if (command.action === "send" && expected !== undefined) {
          const steering = await tx.createTask(
            Steering,
            {
              path: child.path,
              message,
              expected,
              requestId,
              ...(command.images?.length ? { images: [...command.images] } : {}),
            },
            { ownership: { kind: "conversation" }, background: true },
          );
          child.steering ??= [];
          child.steering.push(steering);
          await armTimeout(expected);
          doc.requests[requestId] = child.path;
          return child.path;
        }
        const reporter = await tx.createTask(
          Reporter,
          {
            path: child.path,
            message,
            ...(command.images?.length ? { images: [...command.images] } : {}),
          },
          { ownership: { kind: "conversation" }, background: true },
        );
        child.pending.push(reporter);
        await armTimeout(reporter);
        if (!child.active.length) child.status = "queued";
        delete child.error;
        doc.requests[requestId] = child.path;
        return child.path;
      },
      context,
    );
    return `Sent to ${path}`;
  };
  const list = async (
    context = BACKGROUND_CONTEXT,
    actor = ROOT_CONVERSATION_ID,
  ): Promise<SubagentSummary[]> => {
    const doc = await state(context);
    return (doc?.agents ?? [])
      .filter((child) => visible(child, actor, doc!.agents))
      .map((child) => ({
        path: child.path,
        parent: child.parent,
        conversationId: child.conversationId,
        depth: child.depth,
        fork: child.fork,
        status: child.paused ? "paused" : child.status,
        model: child.model,
        ...(child.error ? { error: child.error } : {}),
        ...(child.canDelegate !== undefined ? { canDelegate: child.canDelegate } : {}),
        ...(child.progress ? { progress: child.progress } : {}),
        ...(child.output !== undefined
          ? {
              output: child.output.slice(0, 16000),
              ...(child.output.length > 16000 ? { outputTruncated: true } : {}),
            }
          : {}),
      }));
  };
  const stopAll = async () => {
    await commit(
      ROOT_CONVERSATION_ID,
      async (tx) => {
        const doc = await tx.doc(SubagentsDoc);
        doc.stopping = true;
        // Mark live children before aborting their reporters, which clear the execution arrays.
        for (const child of doc.agents) {
          if (
            child.active.length ||
            child.pending.length ||
            child.settling?.length ||
            child.steering?.length
          )
            child.stopping = true;
        }
      },
      BACKGROUND_CONTEXT,
    );
    try {
      await (await options.harness().conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))!.abort(
        BACKGROUND_CONTEXT,
        { background: true },
      );
      const doc = await state(BACKGROUND_CONTEXT);
      for (const child of doc?.agents.filter(
        (child) =>
          child.parent === "/root" &&
          (child.stopping ||
            doc.agents.some(
              (descendant) =>
                descendant.stopping && isDescendant(descendant, child.path, doc.agents),
            )),
      ) ?? [])
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
  // Recovery permission lives in the desktop adapter; publish a revision to release waiting gates.
  const wake = () =>
    commit(
      ROOT_CONVERSATION_ID,
      async (tx) => {
        const doc = await tx.doc(SubagentsDoc);
        doc.revision++;
      },
      BACKGROUND_CONTEXT,
    );
  return { execute, list, wait, stopAll, wake };
}
