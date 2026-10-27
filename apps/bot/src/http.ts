import { SnapshotDeltaEncoder } from "@eta/core/shared/snapshot-delta";
import { heartbeat } from "./sse-heartbeat.ts";
import { mountScheduleRoutes } from "./schedule-http.ts";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { compressEvents, compressJson } from "./compression.ts";
import { displayOperation, displaySnapshot } from "./snapshot.ts";
import { streamSSE } from "hono/streaming";
import { SubagentCommandSchema } from "@eta/core/shared/subagent-schema";
import { Schema } from "effect";
import type { CoreClient } from "@eta/core";
import type { BotConfig } from "./config.ts";
import { BotHttpError, httpError } from "./errors.ts";
import { BotController } from "./controller.ts";
import { BotProjects } from "./projects.ts";
import { BotStore } from "./store.ts";
import { SandboxModeSchema, sandboxModes } from "@eta/core/shared/sandbox";
import { diagnoseRequest } from "./request-diagnostics.ts";
import type { BotLog } from "./log.ts";

const RequestId = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Create = Schema.Struct({
  workspaceId: Schema.NullOr(Schema.NonEmptyString),
  requestId: RequestId,
  configuration: Schema.optionalKey(
    Schema.Struct({
      provider: Schema.NonEmptyString,
      modelId: Schema.NonEmptyString,
      sandboxMode: Schema.optionalKey(SandboxModeSchema),
      thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    }),
  ),
});
const Message = Schema.Struct({
  requestId: RequestId,
  prompt: Schema.String,
  images: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("image"),
        data: Schema.NonEmptyString,
        mimeType: Schema.NonEmptyString,
        name: Schema.optionalKey(Schema.String),
        note: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

export const BOT_CAPABILITIES = [
  "agent-mode",
  "approval-review",
  "git-metadata",
  "git",
  "worktree",
  "github",
  "schedules",
  "temporary-workspace",
] as const;

function decode<A>(schema: Schema.ConstraintDecoder<A>, input: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
  } catch {
    throw new BotHttpError(400, "InvalidInput", "Request fields are invalid.");
  }
}

async function readBody(request: { json(): Promise<unknown> }) {
  try {
    return await request.json();
  } catch {
    throw new BotHttpError(400, "InvalidInput", "Request must be JSON.");
  }
}

export function createHttpApp(options: {
  config: BotConfig;
  projects: BotProjects;
  credentials: {
    list(): Promise<readonly { providerId: string; type: "api_key" | "oauth" }[]>;
    import(values: unknown): Promise<void>;
    remove(provider: string): Promise<void>;
  };
  core: CoreClient;
  controller: BotController;
  store: BotStore;
  workspaceProjects: ReadonlyMap<string, string>;
  shutdown: AbortSignal;
  extensionStatus?: () => unknown;
  log?: BotLog;
}) {
  const { config, core, controller, store, workspaceProjects, shutdown } = options;
  const app = new Hono();
  app.use("/v1/*", compressJson, compressEvents);
  app.onError((error, context) => {
    if (error instanceof HTTPException && error.status === 401)
      return context.json(
        { error: { code: "Unauthorized", message: "A valid administrator token is required." } },
        401,
      );
    const mapped = httpError(error);
    return context.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
  });
  app.notFound((context) =>
    context.json({ error: { code: "NotFound", message: "Route not found." } }, 404),
  );
  app.get("/healthz", (context) => context.json({ healthy: true }));
  app.get("/readyz", (context) =>
    context.json({ ready: !shutdown.aborted }, shutdown.aborted ? 503 : 200),
  );
  app.use("/v1/*", bearerAuth({ token: config.adminToken }));
  app.use("/v1/*", async (_context, next) => {
    if (shutdown.aborted) throw new BotHttpError(503, "RuntimeClosing", "Bot is shutting down.");
    await next();
  });
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 48 * 1024 * 1024,
      onError: (context) =>
        context.json(
          { error: { code: "PayloadTooLarge", message: "Request body exceeds 48 MiB." } },
          413,
        ),
    }),
  );
  app.get("/v1/status", (context) =>
    context.json({
      ...controller.status(),
      // Clients gate newer features on this list instead of probing routes.
      capabilities: BOT_CAPABILITIES,
      extensions: options.extensionStatus?.() ?? {},
    }),
  );
  app.post("/v1/credentials/import", async (context) => {
    const input = decode(
      Schema.Struct({ credentials: Schema.Record(Schema.NonEmptyString, Schema.Unknown) }),
      await readBody(context.req),
    );
    await options.credentials.import(input.credentials);
    return context.json({ imported: Object.keys(input.credentials).length });
  });
  app.post("/v1/credentials/remove", async (context) => {
    const input = decode(
      Schema.Struct({ providerId: Schema.NonEmptyString }),
      await readBody(context.req),
    );
    await options.credentials.remove(input.providerId);
    return context.json({ removed: true });
  });
  // Folder creation validates and publishes its own scope without a preliminary scan.
  app.post("/v1/projects", async (context) => {
    const input = decode(
      Schema.Struct({ name: Schema.NonEmptyString, requestId: RequestId }),
      await readBody(context.req),
    );
    let refreshed = false;
    const result = await store.request(
      `project.create:${config.workspaceRoot}`,
      input.requestId,
      JSON.stringify({ name: input.name }),
      async () => {
        const project = await options.projects.create(input.name);
        refreshed = true;
        return project;
      },
    );
    // Replays and coalesced callers did not run their own creation's post-refresh.
    if (!refreshed) await options.projects.refresh();
    if (![...workspaceProjects.values()].includes(result.id))
      throw new BotHttpError(403, "ProjectUnavailable", "项目必须位于 Bot 工作空间根目录内。");
    return context.json(result, 201);
  });
  // Messages validate their target paths on every request, including durable receipt replays,
  // without discovering unrelated projects. Complex aliases still fall back to a full scan.
  app.post("/v1/threads/:id/messages", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.authorize(id);
    const input = decode(Message, await readBody(context.req));
    const result = await store.request(
      `messages:${id}`,
      input.requestId,
      JSON.stringify({
        prompt: input.prompt,
        ...(input.images === undefined ? {} : { images: input.images }),
      }),
      () => controller.submit(id, input.prompt, `http:messages:${input.requestId}`, input.images),
    );
    return context.json(result, 202);
  });
  // Single-thread reads need fresh target scope, not unrelated project discovery.
  app.get("/v1/threads/:id", async (context) => {
    const id = context.req.param("id");
    return diagnoseRequest(options.log, "thread.read", async (phase) => {
      await options.projects.refreshForThread(id);
      phase("authorize");
      await controller.authorize(id);
      phase("open");
      const snapshot = await core.openThread(id);
      phase("encode");
      return context.json(displaySnapshot(snapshot));
    });
  });
  app.get("/v1/threads/:id/operations/:operationId", async (context) => {
    const id = context.req.param("id");
    return diagnoseRequest(options.log, "thread.operation", async (phase) => {
      await options.projects.refreshForThread(id);
      phase("authorize");
      await controller.authorize(id);
      phase("open");
      const operation = await core.operation(id, context.req.param("operationId"));
      phase("encode");
      return context.json(displayOperation(operation));
    });
  });
  app.get("/v1/threads/:id/events", async (context) => {
    const id = context.req.param("id");
    await diagnoseRequest(options.log, "thread.subscribe", async (phase) => {
      await options.projects.refreshForThread(id);
      phase("authorize");
      await controller.authorize(id);
    });
    const signal = AbortSignal.any([shutdown, context.req.raw.signal]);
    const encoder =
      context.req.header("x-eta-snapshot") === "delta-v1" ? new SnapshotDeltaEncoder() : undefined;
    return streamSSE(context, async (stream) => {
      let stop: (() => void) | undefined;
      let stopHeartbeat: (() => void) | undefined;
      let stopped = false;
      const ended = Promise.withResolvers<void>();
      const end = () => {
        stopped = true;
        stopHeartbeat?.();
        stop?.();
        stop = undefined;
        ended.resolve();
      };
      signal.addEventListener("abort", end, { once: true });
      stream.onAbort(end);
      try {
        if (signal.aborted) return;
        stopHeartbeat = heartbeat(stream, end);
        stop = await diagnoseRequest(options.log, "thread.subscribe", async (phase) => {
          phase("subscribe");
          return core.subscribe(
            id,
            async (snapshot) => {
              if (!signal.aborted && !stopped)
                await stream.writeSSE(
                  encoder
                    ? encoder.encode(displaySnapshot(snapshot))
                    : {
                        event: "snapshot",
                        data: JSON.stringify(displaySnapshot(snapshot)),
                      },
                );
            },
            (message) => {
              void stream
                .writeSSE({ event: "error", data: JSON.stringify({ message }) })
                .catch(() => {});
              end();
            },
            context.req.query("path"),
          );
        });
        if (signal.aborted || stopped) end();
        await ended.promise;
      } finally {
        end();
        signal.removeEventListener("abort", end);
      }
    });
  });
  // Cancelling and resuming need the target scope, not unrelated project discovery.
  app.post("/v1/threads/:id/stop", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.stop(id);
    return context.json({ stopped: true });
  });
  app.post("/v1/threads/:id/resume", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.resume(id);
    return context.json({ resumed: true }, 202);
  });
  // Thread administration and approvals need the target scope, not unrelated discovery.
  app.post("/v1/threads/:id/configure", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.authorize(id);
    const input = decode(
      Schema.Struct({
        provider: Schema.NonEmptyString,
        modelId: Schema.NonEmptyString,
        thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
      }),
      await readBody(context.req),
    );
    return context.json(
      displaySnapshot(
        await core.configureThread(id, input.provider, input.modelId, input.thinkingLevel),
      ),
    );
  });
  app.post("/v1/threads/:id/sandbox", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.authorize(id);
    const input = decode(Schema.Struct({ mode: SandboxModeSchema }), await readBody(context.req));
    return context.json(displaySnapshot(await core.configureSandbox(id, input.mode)));
  });
  app.post("/v1/threads/:id/approvals/:requestId", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.authorize(id);
    const input = decode(
      Schema.Struct({
        approved: Schema.Boolean,
        reuse: Schema.optionalKey(Schema.Literals(["call", "run"])),
      }),
      await readBody(context.req),
    );
    return context.json(
      displaySnapshot(
        await core.decideApproval(id, context.req.param("requestId"), input.approved, input.reuse),
      ),
    );
  });
  // Local metadata mutations only need the source; moves also validate their destination.
  app.post("/v1/threads/:id/metadata", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.authorize(id);
    const input = decode(
      Schema.Union([
        Schema.Struct({ action: Schema.Literal("rename"), title: Schema.NonEmptyString }),
        Schema.Struct({ action: Schema.Literal("archive"), archived: Schema.Boolean }),
        Schema.Struct({
          action: Schema.Literal("move"),
          projectId: Schema.NullOr(Schema.NonEmptyString),
        }),
        Schema.Struct({ action: Schema.Literal("delete") }),
      ]),
      await readBody(context.req),
    );
    switch (input.action) {
      case "rename":
        return context.json(await core.renameThread(id, input.title));
      case "archive":
        return context.json(await core.archiveThread(id, input.archived));
      case "move":
        // Moving changes the display project, so validate the destination directory too.
        await options.projects.refresh();
        await controller.authorize(id);
        if (input.projectId !== null && ![...workspaceProjects.values()].includes(input.projectId))
          throw new BotHttpError(
            403,
            "ProjectUnavailable",
            "Project is outside the configured projects.",
          );
        return context.json(await core.moveThread(id, input.projectId));
      case "delete":
        await core.deleteThread(id);
        return context.json({ deleted: true });
    }
  });
  // Maintenance actions also need only the target scope.
  app.post("/v1/threads/:id/compact", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.compact(id);
    return context.json({ compacted: true });
  });
  app.post("/v1/threads/:id/unload-skill", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.authorize(id);
    const input = decode(
      Schema.Struct({ name: Schema.NonEmptyString }),
      await readBody(context.req),
    );
    await core.unloadSkill(id, input.name);
    return context.json({ unloaded: true });
  });
  // Child commands stay within the owning thread runtime and need only its fresh scope.
  app.post("/v1/threads/:id/subagent", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForThread(id);
    await controller.authorize(id);
    const input = decode(
      Schema.Struct({ command: SubagentCommandSchema, requestId: RequestId }),
      await readBody(context.req),
    );
    return context.json(await controller.subagent(id, input.command, input.requestId));
  });
  // Workspace requests validate only their target before reads, writes or cached replies.
  const ownedWorkspace = (id: string) => {
    if (!workspaceProjects.has(id))
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "Workspace is outside the configured projects.",
      );
    return id;
  };
  app.get("/v1/workspaces/:id/git", async (context) => {
    const id = context.req.param("id");
    return diagnoseRequest(options.log, "workspace.git", async (phase) => {
      await options.projects.refreshForWorkspace(id);
      phase("git");
      const repository = await core.gitRepository(ownedWorkspace(id));
      phase("encode");
      return context.json(repository);
    });
  });
  app.get("/v1/workspaces/:id/branches", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForWorkspace(id);
    return context.json(await core.gitBranches(ownedWorkspace(id)));
  });
  app.post("/v1/workspaces/:id/remove", async (context) => {
    const id = context.req.param("id");
    await options.projects.refreshForWorkspace(id);
    ownedWorkspace(id);
    const input = decode(Schema.Struct({ requestId: RequestId }), await readBody(context.req));
    return context.json(await core.removeWorktree(id, input.requestId));
  });
  app.get("/v1/skills", async (context) => {
    const workspaceId = context.req.query("workspaceId");
    if (workspaceId) await options.projects.refreshForWorkspace(workspaceId);
    const workspace = (await core.workspaces()).find(
      (value) => value.id === workspaceId && workspaceProjects.has(value.id),
    );
    if (!workspace)
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "Workspace is outside the configured projects.",
      );
    return context.json(await core.skills(workspace.cwd));
  });
  app.post("/v1/threads", async (context) => {
    const input = decode(Create, await readBody(context.req));
    if (input.workspaceId !== null) await options.projects.refreshForWorkspace(input.workspaceId);
    if (input.workspaceId !== null && !workspaceProjects.has(input.workspaceId))
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "Workspace is outside the configured projects.",
      );
    const result = await store.request(
      "create",
      input.requestId,
      JSON.stringify({
        workspaceId: input.workspaceId,
        ...(input.configuration ? { configuration: input.configuration } : {}),
      }),
      () =>
        core.createThread(input.workspaceId, `http:create:${input.requestId}`, input.configuration),
    );
    if (input.workspaceId === null) {
      await options.projects.refreshForThread(result.id);
      ownedWorkspace(result.thread.workspaceId);
    }
    return context.json(displaySnapshot(result), 201);
  });
  // Known-project operations scope their owner before consuming project resources.
  const ownedProject = async (id: string) => {
    const roots = (await core.workspaces(id)).filter(
      (workspace) => workspace.kind === "project-root",
    );
    if (roots.length === 1) {
      const root = roots[0]!;
      await options.projects.refreshForWorkspace(root.id);
      // Other worktrees may still have old grants after this project's root escapes.
      if (workspaceProjects.get(root.id) === id) return id;
    } else {
      // Older catalogs may have no unique root record; preserve full discovery's selection.
      await options.projects.refresh();
      if ([...workspaceProjects.values()].includes(id)) return id;
    }
    throw new BotHttpError(
      403,
      "ProjectUnavailable",
      "Project is outside the configured projects.",
    );
  };
  app.get("/v1/projects/:id/github/identity", async (context) => {
    await ownedProject(context.req.param("id"));
    return context.json(await core.githubIdentity());
  });
  app.post("/v1/projects/:id/github", async (context) => {
    const projectId = await ownedProject(context.req.param("id"));
    const input = decode(
      Schema.Struct({
        kind: Schema.Literals(["pulls", "issues"]),
        state: Schema.Literals(["open", "closed", "all"]),
        cursor: Schema.optionalKey(Schema.NonEmptyString),
        refresh: Schema.optionalKey(Schema.Boolean),
      }),
      await readBody(context.req),
    );
    return context.json(await core.githubQuery({ ...input, projectId }));
  });
  app.get("/v1/projects/:id/worktrees", async (context) =>
    context.json(await core.listWorktrees(await ownedProject(context.req.param("id")))),
  );
  app.post("/v1/projects/:id/worktrees/reconcile", async (context) => {
    const result = await core.reconcileWorktrees(await ownedProject(context.req.param("id")));
    await options.projects.refresh(true);
    return context.json(result);
  });
  app.post("/v1/projects/:id/worktrees", async (context) => {
    const projectId = await ownedProject(context.req.param("id"));
    const input = decode(
      Schema.Struct({
        baseWorkspaceId: Schema.NonEmptyString,
        branch: Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("new"),
            name: Schema.NonEmptyString,
            baseRef: Schema.optionalKey(Schema.NonEmptyString),
          }),
          Schema.Struct({ kind: Schema.Literal("existing"), name: Schema.NonEmptyString }),
        ]),
        requestId: RequestId,
        continuesWorkspaceId: Schema.optionalKey(Schema.NonEmptyString),
      }),
      await readBody(context.req),
    );
    await options.projects.refreshForWorkspace(input.baseWorkspaceId);
    ownedWorkspace(input.baseWorkspaceId);
    const created = await core.createWorktree({ projectId, ...input });
    // The new workspace lives under `.eta-worktrees`, which project discovery skips but scoping includes.
    await options.projects.refresh(true);
    return context.json(created, 201);
  });
  app.post("/v1/projects/:id/github-remote", async (context) => {
    const projectId = await ownedProject(context.req.param("id"));
    const input = decode(
      Schema.Struct({
        remoteName: Schema.NullOr(Schema.NonEmptyString),
        requestId: Schema.optionalKey(RequestId),
      }),
      await readBody(context.req),
    );
    return context.json(
      await core.selectGitHubRemote(projectId, input.remoteName, input.requestId),
    );
  });
  // Remaining scoped routes refresh all ownership on every request.
  app.use("/v1/*", async (_context, next) => {
    await options.projects.refresh();
    await next();
  });
  app.get("/v1/projects", async (context) =>
    context.json(
      (await core.projects()).filter((project) =>
        [...workspaceProjects.values()].includes(project.id),
      ),
    ),
  );
  app.get("/v1/workspaces", async (context) =>
    context.json(
      (await core.workspaces()).filter((workspace) => workspaceProjects.has(workspace.id)),
    ),
  );
  app.get("/v1/library", async (context) => {
    const projects = (await core.projects()).filter((project) =>
      [...workspaceProjects.values()].includes(project.id),
    );
    const workspaces = (await core.workspaces()).filter((workspace) =>
      workspaceProjects.has(workspace.id),
    );
    const threads = (await core.threads(undefined, true)).filter((thread) =>
      workspaceProjects.has(thread.workspaceId),
    );
    return context.json({
      credentials: await options.credentials.list(),
      workspaceRoot: config.workspaceRoot,
      projects,
      workspaces,
      threads,
      models: await core.models(),
      settings: config.runtime,
      allowedSandboxModes: config.allowedSandboxModes ?? sandboxModes,
    });
  });
  mountScheduleRoutes(app, { core, workspaceProjects, shutdown, decode, readBody });
  return app;
}
