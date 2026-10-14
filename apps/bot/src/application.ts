import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models } from "@earendil-works/pi-ai";
import { botScheduleAdapter } from "./schedules.ts";
import { createCore, CoreError } from "@eta/core";
import type { CoreEnvironment } from "@eta/core";
import { processImage } from "@eta/core/node/images";
import type { BotConfig } from "./config.ts";
import { CredentialService } from "@eta/core/service/credentials/index";
import { AppPathsService } from "@eta/core/platform/app-paths";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { BotStore, lockDataRoot } from "./store.ts";
import { BotProjects } from "./projects.ts";
import { BotController } from "./controller.ts";
import { createHttpApp } from "./http.ts";
import { BotExtensions } from "./extensions.ts";
import { DiscordExtension } from "../extensions/discord/index.ts";
import type { DiscordPort } from "../extensions/discord/types.ts";
import type { BotLog } from "./log.ts";

export async function createBotApplication(
  config: BotConfig,
  dependencies: {
    models?: Models;
    environment?: Partial<CoreEnvironment>;
    discordPort?: DiscordPort;
    log?: BotLog;
  } = {},
) {
  const worker = fileURLToPath(new URL("./sandbox-worker.mjs", import.meta.url));
  await mkdir(config.dataRoot, { recursive: true });
  const unlock = lockDataRoot(join(config.dataRoot, "writer-lock.sqlite"));
  registerBunOAuthFlows();
  const credentialsRuntime = ManagedRuntime.make(
    CredentialService.layer.pipe(Layer.provide(AppPathsService.layer(config.dataRoot))),
  );
  let core: Awaited<ReturnType<typeof createCore>> | undefined;
  let store: BotStore | undefined;
  let extensions: BotExtensions | undefined;
  let discord: DiscordExtension | undefined;
  let scheduleProjects: BotProjects | undefined;
  try {
    const credentials = await credentialsRuntime.runPromise(CredentialService);
    store = new BotStore(join(config.dataRoot, "bot.sqlite"));
    discord = config.discord
      ? new DiscordExtension(
          config.discord,
          join(config.dataRoot, "discord.sqlite"),
          dependencies.discordPort,
        )
      : undefined;
    extensions = new BotExtensions(discord ? [discord] : []);
    const registered = extensions;
    const models = dependencies.models ?? builtinModels({ credentials: credentials.store });
    // A typo should fail fast; a known model without credentials yet is handled per review.
    const reviewer = config.runtime.approvalReviewer?.model;
    if (reviewer && !models.getModel(reviewer.provider, reviewer.modelId))
      throw new Error(
        `Unknown approval reviewer model ${reviewer.provider}/${reviewer.modelId}; check runtime.approvalReviewer.model.`,
      );
    core = await createCore({
      dataRoot: config.dataRoot,
      home: config.home ?? join(config.dataRoot, "home"),
      models,
      settings: { read: Effect.succeed(config.runtime), subscribe: () => () => {} },
      processImage,
      environment: {
        userAgent: "eta-bot",
        shutdown: "preserve",
        allowedSandboxModes: config.allowedSandboxModes ?? ["read-only", "workspace-write"],
        sandboxWorkerPath: existsSync(worker) ? worker : undefined,
        // A dot directory: project discovery skips it, yet it stays inside the workspace root's scope.
        worktreeRoot: join(config.workspaceRoot, ".eta-worktrees"),
        ...dependencies.environment,
        authorizeScheduleWorkspace: async (workspaceId) => {
          if (!scheduleProjects)
            throw new CoreError({ code: "Busy", message: "Bot 项目扫描尚未完成" });
          await scheduleProjects.refresh();
          if (!scheduleProjects.workspaceProjects.has(workspaceId))
            throw new CoreError({
              code: "WorkspaceUnavailable",
              message: "工作区不在 Bot 授权范围内",
            });
          await dependencies.environment?.authorizeScheduleWorkspace?.(workspaceId);
        },
        extensions: async (ref, models) => [
          ...((await dependencies.environment?.extensions?.(ref, models)) ?? []),
          ...registered.runtimeExtensions(),
        ],
      },
    });
    const projects = new BotProjects(core, config);
    scheduleProjects = projects;
    await projects.refresh();
    const { projectKeys, workspaceProjects } = projects;
    const log = dependencies.log ?? (() => {});
    const controller = new BotController(core, workspaceProjects, config.maxConcurrent ?? 1, log);
    const projectWorkspaces = new Map(
      [...projectKeys].map(([key, id]) => [
        key,
        [...workspaceProjects].find(([, projectId]) => projectId === id)![0],
      ]),
    );
    extensions.initialize({ core, controller, workspaces: projectWorkspaces, log });
    const shutdown = new AbortController();
    const app = createHttpApp({
      config,
      credentials: {
        list: () => credentialsRuntime.runPromise(credentials.list),
        import: (values: unknown) => credentialsRuntime.runPromise(credentials.import(values)),
        remove: (provider: string) => credentialsRuntime.runPromise(credentials.remove(provider)),
      },
      projects,
      core,
      controller,
      store,
      workspaceProjects,
      shutdown: shutdown.signal,
      extensionStatus: () => registered.status(),
    });
    extensions.mount(app);
    await extensions.prepareRecovery();
    await controller.recover();
    await extensions.start();
    await core.startScheduler(botScheduleAdapter(core, controller, projects));
    const client = core;
    const persistence = store;
    let closing: Promise<void> | undefined;
    return {
      app,
      core: client,
      projectKeys,
      workspaceProjects,
      controller,
      discord,
      close: () =>
        (closing ??= (async () => {
          shutdown.abort();
          try {
            await client.stopScheduler();
          } finally {
            try {
              await registered.stopIngress();
            } finally {
              try {
                await controller.close(config.shutdownGraceMs);
              } finally {
                try {
                  await client.close();
                } finally {
                  try {
                    await registered.close();
                  } finally {
                    try {
                      await persistence.close();
                    } finally {
                      await credentialsRuntime.dispose();
                      unlock();
                    }
                  }
                }
              }
            }
          }
        })()),
    };
  } catch (error) {
    await extensions?.stopIngress();
    try {
      await core?.close();
    } finally {
      try {
        try {
          await extensions?.close();
        } finally {
          await store?.close();
        }
      } finally {
        await credentialsRuntime.dispose();
        unlock();
      }
    }
    throw error;
  }
}

export type BotApplication = Awaited<ReturnType<typeof createBotApplication>>;
