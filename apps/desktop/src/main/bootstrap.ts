import { readFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import type { ImageAttachment, ImageSource, ImageProcessor } from "../images/types.ts";
import { randomUUID } from "node:crypto";
import { registerBunOAuthFlows as registerBundledOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { Schema } from "effect";
import { DesktopAuthentication } from "./authentication/index.ts";
import type { LoginMethod } from "../authentication.ts";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { loadProjectEnvironment } from "./environment.ts";
import { readAgentCredentials } from "../agent/agent-credentials.ts";
import { readAgentSettings } from "../agent/agent-settings.ts";
import type { ThinkingLevel } from "../agent/protocol.ts";
import type { DesktopLibrary } from "../bridge.ts";
import { CredentialService } from "./service/credentials/index.ts";
import { DesktopCatalogService } from "./service/catalog/index.ts";
import { readJson, writeJson } from "./service/json-file.ts";
import { desktopServices } from "./service/layer.ts";
import { ModelCatalogService } from "./service/models/index.ts";
import { ProjectService } from "./service/projects/index.ts";
import { DesktopSettingsService } from "./service/settings/index.ts";
import type { DesktopSettings } from "./service/settings/index.ts";
import { ThreadService } from "./service/threads/index.ts";
import { SkillsService } from "./service/skills/index.ts";
import { scanStorage, storageTargetPath } from "./storage/index.ts";
import type { StorageTarget } from "./storage/types.ts";

/** Electron supplies directories here; the services never call app.getPath themselves. */
export async function createDesktopApplication(
  root: string,
  cwd: string,
  dataRoot: string,
  openExternal: (url: string) => Promise<void> = async () => {
    throw new Error("浏览器不可用");
  },
  processImage?: ImageProcessor,
  revealPath: (path: string) => void = () => {
    throw new Error("文件管理器不可用");
  },
  openDirectory: (path: string) => Promise<void> = async () => {
    throw new Error("文件管理器不可用");
  },
) {
  // Despite its name, pi-ai's registration is runtime-independent and embeds OAuth in CJS bundles.
  registerBundledOAuthFlows();
  await loadProjectEnvironment(root);
  const runtime = ManagedRuntime.make(desktopServices(dataRoot, undefined, processImage));
  try {
    const projects = await runtime.runPromise(ProjectService);
    const threads = await runtime.runPromise(ThreadService);
    const settings = await runtime.runPromise(DesktopSettingsService);
    const credentials = await runtime.runPromise(CredentialService);
    const models = await runtime.runPromise(ModelCatalogService);
    const catalog = await runtime.runPromise(DesktopCatalogService);
    const skills = await runtime.runPromise(SkillsService);
    const installationPath = join(dataRoot, "installation.json");
    const installation = await readJson(installationPath);
    const deviceId =
      installation === undefined
        ? randomUUID()
        : Schema.decodeUnknownSync(Schema.Struct({ id: Schema.NonEmptyString }))(installation).id;
    if (installation === undefined) await writeJson(installationPath, { id: deviceId });
    const authentication = new DesktopAuthentication(
      models.models,
      credentials.store,
      openExternal,
      deviceId,
    );
    if ((await readJson(join(dataRoot, "credentials.json"))) === undefined)
      await runtime.runPromise(credentials.importOnce(await readAgentCredentials()));
    if ((await readJson(join(dataRoot, "settings.json"))) === undefined) {
      const legacy = await readAgentSettings();
      await runtime.runPromise(
        settings.update({ ...legacy, defaultThinkingLevel: legacy.defaultThinkingLevel ?? "off" }),
      );
    }
    if (!(await runtime.runPromise(projects.list())).length)
      await runtime.runPromise(projects.register({ rootPath: cwd }));
    const cwdDefault = cwd;
    const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
    return {
      skills: (cwd?: string) => run(skills.catalog(cwd)),
      openSkillsDirectory: async (path: string, cwd?: string) =>
        openDirectory(await run(skills.prepareDirectory(path, cwd))),
      unloadSkill: (id: string, name: string) => run(threads.unloadSkill(id, name)),
      subscribeLibrary: (listener: () => void) => catalog.subscribe(listener),
      storage: async () => scanStorage(dataRoot, await run(catalog.read)),
      revealStorage: async (target: StorageTarget) =>
        revealPath(await storageTargetPath(dataRoot, target)),
      prepareImage: async (
        source: ImageSource,
        cwd?: string,
        provider?: string,
        modelId?: string,
      ) => {
        if (!processImage) throw new Error("图片处理不可用");
        let bytes: Uint8Array;
        let name: string;
        if ("path" in source) {
          const path = resolve(
            cwd ?? cwdDefault,
            source.path.startsWith("~/")
              ? join(process.env.HOME ?? "", source.path.slice(2))
              : source.path,
          );
          if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("图片文件超过 32 MiB");
          bytes = await readFile(path);
          name = basename(path);
        } else {
          bytes = Buffer.from(source.data, "base64");
          name = source.name;
        }
        if (bytes.length > 32 * 1024 * 1024) throw new Error("图片文件超过 32 MiB");
        const model = provider && modelId ? models.models.getModel(provider, modelId) : undefined;
        return processImage(bytes, name, model?.inputLimits?.images?.resize);
      },
      library: async (): Promise<DesktopLibrary> => {
        const state = await run(catalog.read);
        return {
          ...state,
          settings: await run(settings.read),
          models: await run(models.list),
          credentials: await run(credentials.list),
          providers: authentication.providers(),
        };
      },
      registerProject: (rootPath: string, name?: string) =>
        run(projects.register({ rootPath, name })),
      createThread: (workspaceId: string, requestId?: string) =>
        run(threads.create(workspaceId, requestId)),
      openThread: (id: string) => run(threads.open(id)),
      threadFile: async (id: string) => {
        const thread = await run(threads.get(id));
        return join(
          await storageTargetPath(dataRoot, { kind: "session", id: thread.sessionRef.metadata.id }),
          "main.jsonl",
        );
      },
      moveThread: (id: string, projectId: string | null) => run(threads.move(id, projectId)),
      deleteThread: (id: string) => run(threads.remove(id)),
      renameThread: (id: string, title: string) => run(threads.rename(id, title)),
      archiveThread: (id: string, archived: boolean) => run(threads.archive(id, archived)),
      configureThread: (id: string, provider: string, modelId: string, level: ThinkingLevel) =>
        run(threads.configure(id, provider, modelId, level)),
      submit: (
        id: string,
        prompt: string,
        requestId?: string,
        images?: readonly ImageAttachment[],
      ) => run(threads.submit(id, prompt, requestId, images)),
      stop: (id: string) => run(threads.stop(id)),
      resume: (id: string) => run(threads.resume(id)),
      compact: (id: string) => run(threads.compact(id)),
      updateSettings: (patch: Partial<DesktopSettings>) => run(settings.update(patch)),
      startLogin: (provider: string, method: LoginMethod) => authentication.start(provider, method),
      loginState: (id: string) => authentication.read(id),
      answerLogin: (id: string, promptId: string, value: string) =>
        authentication.answer(id, promptId, value),
      cancelLogin: (id: string) => authentication.cancel(id),
      openLoginLink: (id: string, url: string) => authentication.openLink(id, url),
      removeCredential: (provider: string, method: LoginMethod) =>
        authentication.remove(provider, method),
      subscribe: (
        id: string,
        onSnapshot: Parameters<ThreadService["Service"]["subscribe"]>[1],
        onError: (message: string) => void,
      ) => run(threads.subscribe(id, onSnapshot, onError)),
      close: async () => {
        await authentication.close();
        await runtime.dispose();
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export type DesktopApplication = Awaited<ReturnType<typeof createDesktopApplication>>;
