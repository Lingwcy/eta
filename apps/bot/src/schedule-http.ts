import { heartbeat } from "./sse-heartbeat.ts";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Schema } from "effect";
import type { CoreClient } from "@eta/core";
import {
  ScheduleChangeSchema,
  SchedulePatchSchema,
  ScheduleRuleSchema,
  ScheduleNameSchema,
  SchedulePromptSchema,
  ScheduleProposalSchema,
  type ScheduleRequest,
} from "@eta/core/shared/schedules";
import { BotHttpError } from "./errors.ts";

const RequestId = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Write = Schema.Struct({
  requestId: RequestId,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
const Create = Schema.Struct({
  requestId: RequestId,
  name: ScheduleNameSchema,
  prompt: SchedulePromptSchema,
  rule: ScheduleRuleSchema,
});
const Update = Schema.Struct({ ...Write.fields, patch: SchedulePatchSchema });
const Decision = Schema.Struct({ requestId: RequestId, contentFingerprint: Schema.NonEmptyString });
const Propose = Schema.Struct({
  requestId: RequestId,
  change: ScheduleChangeSchema,
  replaces: Schema.optionalKey(
    Schema.Struct({ proposalId: Schema.NonEmptyString, contentFingerprint: Schema.NonEmptyString }),
  ),
});
const ScheduleQuery = Schema.Struct({
  threadId: Schema.optionalKey(Schema.NonEmptyString),
  state: Schema.optionalKey(Schema.Literals(["active", "paused", "completed", "blocked"])),
});
const ProposalQuery = Schema.Struct({
  threadId: Schema.optionalKey(Schema.NonEmptyString),
  state: Schema.optionalKey(ScheduleProposalSchema.fields.state),
});

type ScopeEntity = { threadId: string; workspaceId?: string };

export function mountScheduleRoutes(
  app: Hono,
  options: {
    core: CoreClient;
    workspaceProjects: ReadonlyMap<string, string>;
    shutdown: AbortSignal;
    decode<A>(this: void, schema: Schema.ConstraintDecoder<A>, input: unknown): A;
    readBody(this: void, request: { json(): Promise<unknown> }): Promise<unknown>;
  },
) {
  const { core, workspaceProjects, shutdown, decode, readBody } = options;
  const visibility = async () => {
    const threads = new Map(
      (await core.threads(undefined, true)).map((thread) => [thread.id, thread]),
    );
    return (entity: ScopeEntity) => {
      const workspaceId = threads.get(entity.threadId)?.workspaceId ?? entity.workspaceId;
      return workspaceId !== undefined && workspaceProjects.has(workspaceId);
    };
  };
  const authorize = async (entity: ScopeEntity) => {
    if (!(await visibility())(entity))
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "This schedule is outside the configured projects.",
      );
  };
  const authorizeThread = async (threadId: string) => {
    const thread = (await core.threads(undefined, true)).find((thread) => thread.id === threadId);
    if (!thread) throw new BotHttpError(404, "NotFound", "Thread not found.");
    await authorize({ threadId, workspaceId: thread.workspaceId });
  };
  const schedule = async (id: string) => {
    const found = (await core.scheduleSnapshot()).schedules.find((schedule) => schedule.id === id);
    if (!found) throw new BotHttpError(404, "NotFound", "Schedule not found.");
    await authorize(found);
    return found;
  };
  const proposal = async (id: string, requestId?: string) => {
    const found = (await core.scheduleSnapshot()).proposals.find((proposal) => proposal.id === id);
    if (found) {
      await authorize(found);
      return;
    }
    const receipt = requestId ? await core.scheduleRequest({ requestId }) : undefined;
    if (!receipt || receipt.proposalId !== id)
      throw new BotHttpError(404, "NotFound", "Schedule proposal not found.");
    await authorize(receipt);
  };
  const reply = (context: Context, result: ScheduleRequest, created = false) =>
    context.json(
      result,
      result.state === "pending" ? 202 : result.state === "rejected" ? 409 : created ? 201 : 200,
    );

  app.get("/v1/schedules", async (context) => {
    const query = decode(ScheduleQuery, context.req.query());
    if (query.threadId) await authorizeThread(query.threadId);
    const snapshot = await core.scheduleSnapshot();
    const visible = await visibility();
    return context.json({
      revision: snapshot.revision,
      messageOrigins: snapshot.messageOrigins?.filter((origin) => {
        const plan = snapshot.schedules.find((plan) => plan.id === origin.scheduleId);
        return plan && visible(plan) && (!query.threadId || origin.threadId === query.threadId);
      }),
      occurrences: snapshot.occurrences?.filter((run) => {
        const plan = snapshot.schedules.find((plan) => plan.id === run.scheduleId);
        return plan && visible(plan) && (!query.threadId || run.threadId === query.threadId);
      }),
      proposals: snapshot.proposals.filter(
        (proposal) =>
          visible(proposal) && (!query.threadId || proposal.threadId === query.threadId),
      ),
      requests: snapshot.requests.filter(
        (request) => visible(request) && (!query.threadId || request.threadId === query.threadId),
      ),
      lifecycleIntents: snapshot.lifecycleIntents.filter(
        (intent) => visible(intent) && (!query.threadId || intent.threadId === query.threadId),
      ),
      schedules: snapshot.schedules.filter(
        (schedule) =>
          schedule.deletedAt === undefined &&
          visible(schedule) &&
          (!query.threadId || schedule.threadId === query.threadId) &&
          (!query.state ||
            (query.state === "blocked"
              ? Boolean(schedule.blockedReason)
              : schedule.state === query.state)),
      ),
    });
  });
  app.post("/v1/threads/:id/schedules", async (context) => {
    const input = decode(Create, await readBody(context.req));
    const threadId = context.req.param("id");
    await authorizeThread(threadId);
    return reply(context, await core.createSchedule({ ...input, threadId }), true);
  });
  app.patch("/v1/schedules/:id", async (context) => {
    const input = decode(Update, await readBody(context.req));
    const scheduleId = context.req.param("id");
    await schedule(scheduleId);
    return reply(context, await core.updateSchedule({ ...input, scheduleId }));
  });
  for (const action of ["pause", "resume", "run"] as const) {
    app.post(`/v1/schedules/:id/${action}`, async (context) => {
      const input = decode(Write, await readBody(context.req));
      const scheduleId = context.req.param("id");
      await schedule(scheduleId);
      const request = { ...input, scheduleId };
      const result =
        action === "pause"
          ? await core.pauseSchedule(request)
          : action === "resume"
            ? await core.resumeSchedule(request)
            : await core.runScheduleNow(request);
      return reply(context, result);
    });
  }
  app.delete("/v1/schedules/:id", async (context) => {
    const input = decode(Write, await readBody(context.req));
    const scheduleId = context.req.param("id");
    await schedule(scheduleId);
    return reply(context, await core.deleteSchedule({ ...input, scheduleId }));
  });
  app.get("/v1/schedules/:id/runs", async (context) => {
    const scheduleId = context.req.param("id");
    await schedule(scheduleId);
    return context.json({ scheduleId, runs: await core.listScheduleRuns({ scheduleId }) });
  });
  app.get("/v1/schedule-proposals", async (context) => {
    const query = decode(ProposalQuery, context.req.query());
    if (query.threadId) await authorizeThread(query.threadId);
    const snapshot = await core.scheduleSnapshot();
    const visible = await visibility();
    return context.json({
      revision: snapshot.revision,
      proposals: snapshot.proposals.filter(
        (proposal) =>
          visible(proposal) &&
          (!query.threadId || proposal.threadId === query.threadId) &&
          (!query.state || proposal.state === query.state),
      ),
    });
  });
  app.post("/v1/threads/:id/schedule-proposals", async (context) => {
    const input = decode(Propose, await readBody(context.req));
    const threadId = context.req.param("id");
    await authorizeThread(threadId);
    if (input.replaces) await proposal(input.replaces.proposalId);
    if (input.change.action !== "create") {
      const target = await schedule(input.change.scheduleId);
      if (target.threadId !== threadId)
        throw new BotHttpError(
          400,
          "InvalidInput",
          "The proposal target must belong to this thread.",
        );
    }
    return reply(
      context,
      await core.proposeScheduleChange({
        ...input,
        threadId,
        sourceIdentity: `http:${input.requestId}`,
      }),
      true,
    );
  });
  for (const action of ["approve", "reject"] as const) {
    app.post(`/v1/schedule-proposals/:id/${action}`, async (context) => {
      const input = decode(Decision, await readBody(context.req));
      const proposalId = context.req.param("id");
      await proposal(proposalId, input.requestId);
      return reply(
        context,
        await (action === "approve"
          ? core.approveScheduleProposal({ ...input, proposalId })
          : core.rejectScheduleProposal({ ...input, proposalId })),
      );
    });
  }
  app.get("/v1/schedule-requests/:requestId", async (context) => {
    const requestId = decode(RequestId, context.req.param("requestId"));
    const receipt = await core.scheduleRequest({ requestId });
    if (!receipt) throw new BotHttpError(404, "NotFound", "Schedule request not found.");
    await authorize(receipt);
    return context.json(receipt);
  });
  app.get("/v1/schedules/events", async (context) => {
    const signal = AbortSignal.any([shutdown, context.req.raw.signal]);
    return streamSSE(context, async (stream) => {
      const ended = Promise.withResolvers<void>();
      let stopped = false;
      let publishing = false;
      let dirty = false;
      let unsubscribe: (() => void) | undefined;
      let stopHeartbeat: (() => void) | undefined;
      const end = () => {
        stopped = true;
        stopHeartbeat?.();
        unsubscribe?.();
        unsubscribe = undefined;
        ended.resolve();
      };
      const publish = async () => {
        dirty = true;
        if (publishing || stopped) return;
        publishing = true;
        try {
          while (dirty && !stopped) {
            dirty = false;
            const { revision } = await core.scheduleSnapshot();
            if (!stopped)
              await stream.writeSSE({ event: "schedules", data: JSON.stringify({ revision }) });
          }
        } catch {
          end();
        } finally {
          publishing = false;
        }
      };
      signal.addEventListener("abort", end, { once: true });
      stream.onAbort(end);
      try {
        if (signal.aborted) return;
        stopHeartbeat = heartbeat(stream, end);
        unsubscribe = core.subscribeSchedules(() => {
          void publish();
        });
        await publish();
        if (signal.aborted) end();
        await ended.promise;
      } finally {
        end();
        signal.removeEventListener("abort", end);
      }
    });
  });
}
