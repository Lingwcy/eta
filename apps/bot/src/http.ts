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

const RequestId = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Create = Schema.Struct({
  workspaceId: Schema.NonEmptyString,
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
    await options.projects.refresh();
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
  app.post("/v1/projects", async (context) => {
    const input = decode(
      Schema.Struct({ name: Schema.NonEmptyString, requestId: RequestId }),
      await readBody(context.req),
    );
    const result = await store.request(
      `project.create:${config.workspaceRoot}`,
      input.requestId,
      JSON.stringify({ name: input.name }),
      () => options.projects.create(input.name),
    );
    if (![...workspaceProjects.values()].includes(result.id))
      throw new BotHttpError(403, "ProjectUnavailable", "项目必须位于 Bot 工作空间根目录内。");
    return context.json(result, 201);
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
  const ownedWorkspace = (id: string) => {
    if (!workspaceProjects.has(id))
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "Workspace is outside the configured projects.",
      );
    return id;
  };
  const ownedProject = (id: string) => {
    if (![...workspaceProjects.values()].includes(id))
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "Project is outside the configured projects.",
      );
    return id;
  };
  app.get("/v1/workspaces/:id/git", async (context) =>
    context.json(await core.gitRepository(ownedWorkspace(context.req.param("id")))),
  );
  app.get("/v1/projects/:id/github/identity", async (context) => {
    ownedProject(context.req.param("id"));
    return context.json(await core.githubIdentity());
  });
  app.post("/v1/projects/:id/github", async (context) => {
    const projectId = ownedProject(context.req.param("id"));
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
  app.get("/v1/workspaces/:id/branches", async (context) =>
    context.json(await core.gitBranches(ownedWorkspace(context.req.param("id")))),
  );
  app.get("/v1/projects/:id/worktrees", async (context) =>
    context.json(await core.listWorktrees(ownedProject(context.req.param("id")))),
  );
  app.post("/v1/projects/:id/worktrees/reconcile", async (context) => {
    const result = await core.reconcileWorktrees(ownedProject(context.req.param("id")));
    await options.projects.refresh(true);
    return context.json(result);
  });
  app.post("/v1/projects/:id/worktrees", async (context) => {
    const projectId = ownedProject(context.req.param("id"));
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
    ownedWorkspace(input.baseWorkspaceId);
    const created = await core.createWorktree({ projectId, ...input });
    // The new workspace lives under `.eta-worktrees`, which project discovery skips but scoping includes.
    await options.projects.refresh(true);
    return context.json(created, 201);
  });
  app.post("/v1/workspaces/:id/remove", async (context) => {
    const id = ownedWorkspace(context.req.param("id"));
    const input = decode(Schema.Struct({ requestId: RequestId }), await readBody(context.req));
    return context.json(await core.removeWorktree(id, input.requestId));
  });
  app.post("/v1/projects/:id/github-remote", async (context) => {
    const projectId = ownedProject(context.req.param("id"));
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
  app.get("/v1/skills", async (context) => {
    const workspaceId = context.req.query("workspaceId");
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
  app.post("/v1/threads/:id/configure", async (context) => {
    const id = context.req.param("id");
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
    await controller.authorize(id);
    const input = decode(Schema.Struct({ mode: SandboxModeSchema }), await readBody(context.req));
    return context.json(displaySnapshot(await core.configureSandbox(id, input.mode)));
  });
  app.post("/v1/threads/:id/approvals/:requestId", async (context) => {
    const id = context.req.param("id");
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
  app.post("/v1/threads/:id/metadata", async (context) => {
    const id = context.req.param("id");
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
  app.post("/v1/threads/:id/compact", async (context) => {
    await controller.compact(context.req.param("id"));
    return context.json({ compacted: true });
  });
  app.post("/v1/threads/:id/subagent", async (context) => {
    const id = context.req.param("id");
    await controller.authorize(id);
    const input = decode(
      Schema.Struct({ command: SubagentCommandSchema, requestId: RequestId }),
      await readBody(context.req),
    );
    return context.json(await controller.subagent(id, input.command, input.requestId));
  });
  app.post("/v1/threads/:id/unload-skill", async (context) => {
    const id = context.req.param("id");
    await controller.authorize(id);
    const input = decode(
      Schema.Struct({ name: Schema.NonEmptyString }),
      await readBody(context.req),
    );
    await core.unloadSkill(id, input.name);
    return context.json({ unloaded: true });
  });
  app.post("/v1/threads", async (context) => {
    const input = decode(Create, await readBody(context.req));
    if (!workspaceProjects.has(input.workspaceId))
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
    return context.json(displaySnapshot(result), 201);
  });
  app.get("/v1/threads/:id", async (context) =>
    context.json(displaySnapshot(await controller.authorize(context.req.param("id")))),
  );
  app.post("/v1/threads/:id/messages", async (context) => {
    const id = context.req.param("id");
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
  app.get("/v1/threads/:id/operations/:operationId", async (context) => {
    const id = context.req.param("id");
    await controller.authorize(id);
    return context.json(
      displayOperation(await core.operation(id, context.req.param("operationId"))),
    );
  });
  app.post("/v1/threads/:id/stop", async (context) => {
    await controller.stop(context.req.param("id"));
    return context.json({ stopped: true });
  });
  app.post("/v1/threads/:id/resume", async (context) => {
    await controller.resume(context.req.param("id"));
    return context.json({ resumed: true }, 202);
  });
  app.get("/v1/threads/:id/events", async (context) => {
    const id = context.req.param("id");
    await controller.authorize(id);
    const signal = AbortSignal.any([shutdown, context.req.raw.signal]);
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
        stop = await core.subscribe(
          id,
          async (snapshot) => {
            if (!signal.aborted && !stopped)
              await stream.writeSSE({
                event: "snapshot",
                data: JSON.stringify(displaySnapshot(snapshot)),
              });
          },
          (message) => {
            void stream
              .writeSSE({ event: "error", data: JSON.stringify({ message }) })
              .catch(() => {});
            end();
          },
          context.req.query("path"),
        );
        if (signal.aborted || stopped) end();
        await ended.promise;
      } finally {
        end();
        signal.removeEventListener("abort", end);
      }
    });
  });
  mountScheduleRoutes(app, { core, workspaceProjects, shutdown, decode, readBody });
  return app;
}
