import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models } from "@earendil-works/pi-ai";
import { createCore } from "@eta/core";
import type { CoreEnvironment } from "@eta/core";
import { processImage } from "@eta/core/node/images";
import type { BotConfig } from "./config.ts";
import { environmentCredentials } from "./credentials.ts";
import { BotStore, lockDataRoot } from "./store.ts";
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
  await mkdir(config.dataRoot, { recursive: true });
  const unlock = lockDataRoot(join(config.dataRoot, "writer-lock.sqlite"));
  let core: Awaited<ReturnType<typeof createCore>> | undefined;
  let store: BotStore | undefined;
  let extensions: BotExtensions | undefined;
  let discord: DiscordExtension | undefined;
  try {
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
    core = await createCore({
      dataRoot: config.dataRoot,
      home: config.home ?? join(config.dataRoot, "home"),
      models:
        dependencies.models ??
        builtinModels({ credentials: environmentCredentials(config.credentials) }),
      settings: { read: Effect.succeed(config.runtime), subscribe: () => () => {} },
      processImage,
      environment: {
        userAgent: "eta-bot",
        shutdown: "preserve",
        ...dependencies.environment,
        extensions: async (ref, models) => [
          ...((await dependencies.environment?.extensions?.(ref, models)) ?? []),
          ...registered.runtimeExtensions(),
        ],
      },
    });
    const projectKeys = new Map<string, string>();
    const existingProjects = await core.projects();
    for (const project of config.projects) {
      const path = resolve(project.rootPath);
      // Persist the configured spelling as well as Core's canonical identity. A missing mount or
      // symlink must not hide history; Core validates the canonical workspace before execution.
      const id = await store.request(
        "deployment.project",
        JSON.stringify([project.key, path]),
        path,
        async () => {
          try {
            return (await core!.registerProject(path, project.name)).id;
          } catch (error) {
            const existing = existingProjects.find(({ rootPath }) => rootPath === path);
            const unavailable =
              error instanceof Error &&
              "reason" in error &&
              (error.reason === "PathUnavailable" || error.reason === "NotDirectory");
            if (!existing || !unavailable) throw error;
            return existing.id;
          }
        },
      );
      projectKeys.set(project.key, id);
    }
    const workspaceProjects = new Map(
      (await core.workspaces())
        .filter((workspace) => [...projectKeys.values()].includes(workspace.projectId))
        .map((workspace) => [workspace.id, workspace.projectId]),
    );
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
          await registered.stopIngress();
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
                  unlock();
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
        unlock();
      }
    }
    throw error;
  }
}

export type BotApplication = Awaited<ReturnType<typeof createBotApplication>>;
