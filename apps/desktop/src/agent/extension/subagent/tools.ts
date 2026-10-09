import { defineTool } from "@eta/agent";
import type { ConversationId } from "@eta/agent";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import type { SubagentCommand, SubagentSummary } from "../../../shared/subagents.ts";
import type { SubagentRuntime } from "./runtime.ts";

export function createSubagentTools(
  { settings, state }: SubagentRuntime,
  actions: {
    execute: (
      command: SubagentCommand,
      actor: ConversationId,
      requestId: string,
      context: Context,
    ) => Promise<string>;
    wait: (
      path: string,
      actor: ConversationId,
      timeoutMs: number | undefined,
      context: Context,
    ) => Promise<SubagentSummary>;
    list: (context: Context, actor: ConversationId) => Promise<SubagentSummary[]>;
  },
) {
  const { execute, wait, list } = actions;
  const tool = defineTool({
    name: "subagent",
    description:
      "Manage durable agents. spawn: name, message, fork, optional preset/model/thinkingLevel/canDelegate. Workers execute directly; canDelegate:true is for coordinators. In orchestrator mode ALWAYS spawn with wait:false and yield after assigning work; completion events wake you automatically, so do not poll list. Else spawn waits by default; wait:false starts independent siblings in parallel. Async spawn/send may set timeoutMs (30000–300000) for one status reminder without stopping work; send with only timeoutMs rearms that reminder. wait accepts path and optional timeoutMs (0–3600000); timeout/cancellation never stops the child. send steers a working child or resumes its retained session when idle. output reads the saved answer and progress, with optional offset/limit in characters. stop cancels a subtree; never use it merely because results are not ready. To collect current findings, send a request to summarize and wait for its report. list, pause, resume and stop accept path.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("spawn"),
        Type.Literal("send"),
        Type.Literal("list"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("stop"),
        Type.Literal("wait"),
        Type.Literal("output"),
      ]),
      name: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      fork: Type.Optional(Type.Boolean()),
      wait: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600000 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32000 })),
      canDelegate: Type.Optional(Type.Boolean()),
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
      if (args.action === "spawn" && (args.wait ?? (await settings()).mode !== "orchestrator")) {
        const path = (await state(context))!.requests[`tool:${api.taskId}`]!;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(await wait(path, api.conversationId, args.timeoutMs, context)),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              args.action === "list"
                ? JSON.stringify(await list(context, api.conversationId))
                : text,
          },
        ],
      };
    },
  });
  const updateTool = defineTool({
    name: "agent_update",
    description:
      "Child-only: save a substantive progress update and send it to your parent while continuing work. Include findings, source links, verification state or blockers. This does not finish your task or start a parent turn. Return your final answer normally when done.",
    parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 8000 }) }),
    replay: "safe",
    execute: async (args, api, context) => ({
      content: [
        {
          type: "text",
          text: await execute(
            { action: "update", message: args.message },
            api.conversationId,
            `tool:${api.taskId}`,
            context,
          ),
        },
      ],
    }),
  });
  return { tool, updateTool };
}
