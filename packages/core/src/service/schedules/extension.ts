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
      "Manage time plans for the current root conversation. Writes apply immediately without a separate approval. create requires name/prompt/rule; update requires scheduleId/expectedRevision/patch; pause/resume/delete require scheduleId/expectedRevision. list returns host time and current schedules. Use UTC epoch milliseconds for once and interval anchors, at least 5 minutes for intervals, and HH:mm for daily/weekly rules using the host IANA timeZone from list. Resolve relative dates using host time. Report applied writes accurately; pending means the host is reconciling an uncertain admission and the prior effective state remains. Immediate execution belongs to the client.",
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
        const details = {
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          clock,
          schedules,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details) }],
          details: { threadId: thread.id, workspaceId: thread.workspaceId, clock },
        };
      }
      const change = Schema.decodeUnknownSync(ScheduleChangeSchema, { onExcessProperty: "error" })(
        args,
      );
      const identity = {
        sessionId: options.ref.metadata.id,
        conversationId: api.conversationId,
        taskId: api.taskId,
        callId: api.callId,
      };
      const requestId = `schedule:tool:${scheduleFingerprint(identity)}`;
      const result = await options.run(
        options.schedules.write({ threadId: thread.id, change, requestId }),
      );
      if (result.state === "rejected")
        throw new CoreError({ code: "InvalidInput", message: result.reason ?? "无法变更计划" });
      const schedule = (await options.run(options.schedules.list(thread.id))).find(
        (plan) => plan.id === result.scheduleId,
      );
      const name = schedule?.name ?? (change.action === "create" ? change.name : undefined);
      const rule = schedule?.rule ?? (change.action === "create" ? change.rule : undefined);
      const jsonRule = rule?.type === "weekly" ? { ...rule, weekdays: [...rule.weekdays] } : rule;
      const details = {
        kind: "schedule" as const,
        requestId,
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        ...(result.scheduleId ? { scheduleId: result.scheduleId } : {}),
        action: change.action,
        status: result.state,
        ...(name ? { name } : {}),
        ...(jsonRule ? { rule: jsonRule } : {}),
        nextRunAt: result.nextRunAt ?? schedule?.nextRunAt ?? null,
        clock,
        summary:
          result.state === "pending" ? "正在核对变更结果，原计划状态保持不变" : "计划变更已生效",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });
  return { tool, extension: defineExtension({ name: "scheduled-tasks", tools: [tool] }) };
}
