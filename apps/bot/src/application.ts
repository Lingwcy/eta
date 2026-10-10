import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models } from "@earendil-works/pi-ai";
import { createCore } from "@eta/core";
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
    core = await createCore({
      dataRoot: config.dataRoot,
      home: config.home ?? join(config.dataRoot, "home"),
      models: dependencies.models ?? builtinModels({ credentials: credentials.store }),
      settings: { read: Effect.succeed(config.runtime), subscribe: () => () => {} },
      processImage,
      environment: {
        userAgent: "eta-bot",
        shutdown: "preserve",
        allowedSandboxModes: config.allowedSandboxModes ?? ["read-only", "workspace-write"],
        sandboxWorkerPath: existsSync(worker) ? worker : undefined,
        ...dependencies.environment,
        extensions: async (ref, models) => [
          ...((await dependencies.environment?.extensions?.(ref, models)) ?? []),
          ...registered.runtimeExtensions(),
        ],
      },
    });
    const projects = new BotProjects(core, config);
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
                  await credentialsRuntime.dispose();
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
        await credentialsRuntime.dispose();
        unlock();
      }
    }
    throw error;
  }
}

export type BotApplication = Awaited<ReturnType<typeof createBotApplication>>;
