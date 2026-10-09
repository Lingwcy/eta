import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { Schema } from "effect";
import type { CoreClient } from "@eta/core";
import type { BotConfig } from "./config.ts";
import { BotHttpError, httpError } from "./errors.ts";
import { BotController } from "./controller.ts";
import { BotStore } from "./store.ts";

const RequestId = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Create = Schema.Struct({ workspaceId: Schema.NonEmptyString, requestId: RequestId });
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

function decode<A>(schema: Schema.ConstraintDecoder<A>, input: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
  } catch {
    throw new BotHttpError(400, "InvalidInput", "Request fields are invalid.");
  }
}

export function createHttpApp(options: {
  config: BotConfig;
  core: CoreClient;
  controller: BotController;
  store: BotStore;
  workspaceProjects: ReadonlyMap<string, string>;
  shutdown: AbortSignal;
  extensionStatus?: () => unknown;
}) {
  const { config, core, controller, store, workspaceProjects, shutdown } = options;
  const app = new Hono();
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
    context.json({ ...controller.status(), extensions: options.extensionStatus?.() ?? {} }),
  );
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
  app.post("/v1/threads", async (context) => {
    const input = decode(
      Create,
      await context.req.json().catch(() => {
        throw new BotHttpError(400, "InvalidInput", "Request must be JSON.");
      }),
    );
    if (!workspaceProjects.has(input.workspaceId))
      throw new BotHttpError(
        403,
        "ProjectUnavailable",
        "Workspace is outside the configured projects.",
      );
    const result = await store.request(
      "create",
      input.requestId,
      JSON.stringify({ workspaceId: input.workspaceId }),
      () => core.createThread(input.workspaceId, `http:create:${input.requestId}`),
    );
    return context.json(result, 201);
  });
  app.get("/v1/threads/:id", async (context) =>
    context.json(await controller.authorize(context.req.param("id"))),
  );
  app.post("/v1/threads/:id/messages", async (context) => {
    const id = context.req.param("id");
    await controller.authorize(id);
    const input = decode(
      Message,
      await context.req.json().catch(() => {
        throw new BotHttpError(400, "InvalidInput", "Request must be JSON.");
      }),
    );
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
    return context.json(await core.operation(id, context.req.param("operationId")));
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
      const ended = Promise.withResolvers<void>();
      const end = () => {
        stop?.();
        ended.resolve();
      };
      signal.addEventListener("abort", end, { once: true });
      stream.onAbort(end);
      try {
        if (signal.aborted) return;
        stop = await core.subscribe(
          id,
          async (snapshot) => {
            if (!signal.aborted)
              await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshot) });
          },
          (message) => {
            void stream
              .writeSSE({ event: "error", data: JSON.stringify({ message }) })
              .catch(() => {});
            end();
          },
        );
        if (signal.aborted) end();
        await ended.promise;
      } finally {
        stop?.();
        signal.removeEventListener("abort", end);
      }
    });
  });
  return app;
}
