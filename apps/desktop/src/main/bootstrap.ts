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

/** Electron supplies directories here; the services never call app.getPath themselves. */
export async function createDesktopApplication(
  root: string,
  cwd: string,
  dataRoot: string,
  openExternal: (url: string) => Promise<void> = async () => {
    throw new Error("浏览器不可用");
  },
) {
  // Despite its name, pi-ai's registration is runtime-independent and embeds OAuth in CJS bundles.
  registerBundledOAuthFlows();
  await loadProjectEnvironment(root);
  const runtime = ManagedRuntime.make(desktopServices(dataRoot));
  try {
    const projects = await runtime.runPromise(ProjectService);
    const threads = await runtime.runPromise(ThreadService);
    const settings = await runtime.runPromise(DesktopSettingsService);
    const credentials = await runtime.runPromise(CredentialService);
    const models = await runtime.runPromise(ModelCatalogService);
    const catalog = await runtime.runPromise(DesktopCatalogService);
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
    const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
    return {
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
      renameThread: (id: string, title: string) => run(threads.rename(id, title)),
      archiveThread: (id: string, archived: boolean) => run(threads.archive(id, archived)),
      configureThread: (id: string, provider: string, modelId: string, level: ThinkingLevel) =>
        run(threads.configure(id, provider, modelId, level)),
      submit: (id: string, prompt: string, requestId?: string) =>
        run(threads.submit(id, prompt, requestId)),
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
