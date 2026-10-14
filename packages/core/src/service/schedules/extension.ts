import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from "@eta/agent";
import { DateTime, Effect, Schema } from "effect";
import type { EtaSessionMetadata } from "../../shared/sessions.ts";
import {
  ScheduleChangeSchema,
  ScheduleRuleSchema,
  type ScheduleRule,
} from "../../shared/schedules.ts";
import type { CatalogService } from "../catalog/index.ts";
import type { CoreEnvironment } from "../environment.ts";
import { CoreError } from "../errors.ts";
import type { ScheduleService } from "./index.ts";
import { scheduleFingerprint } from "./management.ts";
import { nextScheduleSlot } from "./time.ts";

export const SCHEDULE_TOOL_NAME = "schedule";
const ObjectOptions = { additionalProperties: false };
const Text = Type.String({ minLength: 1, pattern: "\\S" });
// JSON Schema describes structural checks; the shared decoder also validates IANA zones.
const ruleDocument = Schema.toJsonSchemaDocument(ScheduleRuleSchema, { onExcessProperty: "error" });
const Rule = Type.Unsafe<ScheduleRule>({
  ...ruleDocument.schema,
  $defs: ruleDocument.definitions,
});
const Target = {
  scheduleId: Type.String({ minLength: 1 }),
  expectedRevision: Type.Integer({ minimum: 1 }),
};
export const scheduleToolParameters = Type.Object(
  {
    action: Type.Union(
      (["list", "create", "update", "pause", "resume", "delete"] as const).map((action) =>
        Type.Literal(action),
      ),
    ),
    replaces: Type.Optional(
      Type.Object({ proposalId: Text, contentFingerprint: Text }, ObjectOptions),
    ),
    name: Type.Optional(Text),
    prompt: Type.Optional(Text),
    rule: Type.Optional(Rule),
    scheduleId: Type.Optional(Target.scheduleId),
    expectedRevision: Type.Optional(Target.expectedRevision),
    patch: Type.Optional(
      Type.Object(
        { name: Type.Optional(Text), prompt: Type.Optional(Text), rule: Type.Optional(Rule) },
        ObjectOptions,
      ),
    ),
  },
  ObjectOptions,
);

/** Services are captured by the host; caller arguments never select a thread or authorize a write. */
export function createScheduleExtension(options: {
  ref: EtaSessionMetadata;
  catalog: CatalogService["Service"];
  schedules: ScheduleService["Service"];
  environment: CoreEnvironment;
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
}) {
  const tool = defineTool({
    name: SCHEDULE_TOOL_NAME,
    description:
      "Manage time plans for the current root conversation. create requires name/prompt/rule; update requires scheduleId/expectedRevision/patch; pause/resume/delete require scheduleId/expectedRevision. list returns host time, schedules and pending proposals. Every write creates a proposal for trusted human confirmation, including explicit user instructions. Report successful writes as waiting for confirmation; next time is a preview until approval. Use UTC epoch milliseconds for once and interval anchors, at least 5 minutes for intervals, and HH:mm with an explicit IANA zone for daily/weekly rules. Resolve relative dates using the host time from list; ask for a specific time or zone when unclear. To revise pending content, supply replaces with its proposalId and contentFingerprint; this creates a new proposal and invalidates the old one. Approval and immediate execution belong to the client.",
    parameters: scheduleToolParameters,
    replay: "safe",
    executionMode: "sequential",
    execute: async (args, api) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID)
        throw new CoreError({ code: "InvalidInput", message: "定时任务工具仅对根会话开放" });
      const catalog = await options.run(options.catalog.read);
      const thread = catalog.threads.find(
        (thread) =>
          thread.sessionRef.metadata.id === options.ref.metadata.id &&
          thread.sessionRef.metadata.path === options.ref.metadata.path,
      );
      if (!thread || thread.archivedAt !== undefined)
        throw new CoreError({ code: "InvalidInput", message: "当前根会话未关联可用的 thread" });
      await options.environment.authorizeScheduleWorkspace(thread.workspaceId);
      const now = await options.run(DateTime.now);
      const epochMs = DateTime.toEpochMillis(now);
      const clock = {
        epochMs,
        iso: DateTime.formatIso(now),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      if (args.action === "list") {
        Schema.decodeUnknownSync(Schema.Struct({ action: Schema.Literal("list") }), {
          onExcessProperty: "error",
        })(args);
        const schedules = await options.run(options.schedules.list(thread.id));
        const proposals = (await options.run(options.schedules.proposals(thread.id))).filter(
          (proposal) => proposal.state === "pending" && proposal.expiresAt > epochMs,
        );
        const details = {
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          clock,
          schedules,
          pendingProposals: proposals,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details) }],
          details: { threadId: thread.id, workspaceId: thread.workspaceId, clock },
        };
      }
      const { replaces, ...changeArgs } = args;
      const change = Schema.decodeUnknownSync(ScheduleChangeSchema, { onExcessProperty: "error" })(
        changeArgs,
      );
      const identity = {
        sessionId: options.ref.metadata.id,
        conversationId: api.conversationId,
        taskId: api.taskId,
        callId: api.callId,
      };
      const requestId = `schedule:tool:${scheduleFingerprint(identity)}`;
      const result = await options.run(
        options.schedules.propose({
          threadId: thread.id,
          change,
          requestId,
          sourceIdentity: JSON.stringify(identity),
          ...(replaces ? { replaces } : {}),
        }),
      );
      if (result.state === "rejected")
        throw new CoreError({ code: "InvalidInput", message: result.reason ?? "无法提出计划变更" });
      const proposal = (await options.run(options.schedules.proposals(thread.id))).find(
        (proposal) => proposal.id === result.proposalId,
      );
      if (!proposal)
        throw new CoreError({ code: "NotFound", message: "历史提案已裁剪，请查询当前计划" });
      const current =
        change.action === "create"
          ? undefined
          : (await options.run(options.schedules.list(thread.id))).find(
              (schedule) => schedule.id === change.scheduleId,
            );
      const rule =
        change.action === "create"
          ? change.rule
          : change.action === "update"
            ? (change.patch.rule ?? current?.rule)
            : current?.rule;
      const previewNextRunAt =
        proposal.state !== "pending" ||
        change.action === "pause" ||
        change.action === "delete" ||
        (change.action === "update" && current?.state === "paused") ||
        !rule
          ? null
          : nextScheduleSlot(rule, epochMs);
      const details = {
        proposalId: proposal.id,
        status: proposal.state,
        contentFingerprint: proposal.contentFingerprint,
        parameters: proposal.change,
        workspaceId: proposal.workspaceId,
        expiresAt: proposal.expiresAt,
        previewNextRunAt,
        clock,
        summary:
          proposal.state === "pending"
            ? "等待用户确认；下一次时间仅为预览"
            : `提案状态：${proposal.state}`,
      };
      const { parameters: _parameters, ...metadata } = details;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details: metadata,
      };
    },
  });
  return { tool, extension: defineExtension({ name: "scheduled-tasks", tools: [tool] }) };
}
