import { ManagedRuntime } from "effect";
import type { JsonValue } from "@earendil-works/chord";
import type { ImageAttachment } from "./images/types.ts";
import type { ThinkingLevel } from "./agent/protocol.ts";
import type { SubagentCommand } from "./shared/subagents.ts";
import { coreServices } from "./layer.ts";
import type { CoreOptions } from "./layer.ts";
import { CatalogService } from "./service/catalog/index.ts";
import { ProjectService } from "./service/projects/index.ts";
import { WorkspaceService } from "./service/workspaces/index.ts";
import { ThreadService } from "./service/threads/index.ts";
import { ModelCatalogService } from "./service/models/index.ts";

/** Each invocation creates an independent service graph; the host owns its lifetime through close. */
export async function createCore(options: CoreOptions) {
  const runtime = ManagedRuntime.make(coreServices(options));
  try {
    const threads = await runtime.runPromise(ThreadService);
    const projects = await runtime.runPromise(ProjectService);
    const workspaces = await runtime.runPromise(WorkspaceService);
    const models = await runtime.runPromise(ModelCatalogService);
    const catalog = await runtime.runPromise(CatalogService);
    return {
      projects: () => runtime.runPromise(projects.list()),
      registerProject: (rootPath: string, name?: string) =>
        runtime.runPromise(
          projects.register({ rootPath, ...(name === undefined ? {} : { name }) }),
        ),
      workspaces: (projectId?: string) => runtime.runPromise(workspaces.list(projectId)),
      registerWorkspace: (projectId: string, cwd: string) =>
        runtime.runPromise(workspaces.register(projectId, cwd)),
      models: () => runtime.runPromise(models.list),
      threads: (workspaceId?: string, includeArchived?: boolean) =>
        runtime.runPromise(threads.list(workspaceId, includeArchived)),
      createThread: (workspaceId: string, requestId?: string) =>
        runtime.runPromise(threads.create(workspaceId, requestId)),
      openThread: (id: string) => runtime.runPromise(threads.open(id)),
      renameThread: (id: string, title: string) => runtime.runPromise(threads.rename(id, title)),
      archiveThread: (id: string, archived: boolean) =>
        runtime.runPromise(threads.archive(id, archived)),
      deleteThread: (id: string) => runtime.runPromise(threads.remove(id)),
      moveThread: (id: string, projectId: string | null) =>
        runtime.runPromise(threads.move(id, projectId)),
      configureThread: (id: string, provider: string, modelId: string, level: ThinkingLevel) =>
        runtime.runPromise(threads.configure(id, provider, modelId, level)),
      submit: (
        id: string,
        prompt: string,
        requestId?: string,
        images?: readonly ImageAttachment[],
      ) => runtime.runPromise(threads.submit(id, prompt, requestId, images)),
      operation: (id: string, operationId: string) =>
        runtime.runPromise(threads.operation(id, operationId)),
      operationByRequest: (id: string, requestId: string) =>
        runtime.runPromise(threads.operationByRequest(id, requestId)),
      recovery: (id: string) => runtime.runPromise(threads.recovery(id)),
      enqueueTask: (id: string, kind: string, input: JsonValue, requestId: string) =>
        runtime.runPromise(threads.enqueueTask(id, kind, input, requestId)),
      task: (id: string, taskId: string) => runtime.runPromise(threads.task(id, taskId)),
      stop: (id: string) => runtime.runPromise(threads.stop(id)),
      resume: (id: string) => runtime.runPromise(threads.resume(id)),
      compact: (id: string) => runtime.runPromise(threads.compact(id)),
      subagent: (id: string, command: SubagentCommand, requestId: string) =>
        runtime.runPromise(threads.subagent(id, command, requestId)),
      unloadSkill: (id: string, name: string) => runtime.runPromise(threads.unloadSkill(id, name)),
      subscribe: (
        id: string,
        listener: Parameters<typeof threads.subscribe>[1],
        onError: (message: string) => void,
        path?: string,
      ) => runtime.runPromise(threads.subscribe(id, listener, onError, path)),
      subscribeLibrary: (listener: () => void) => catalog.subscribe(listener),
      close: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export type CoreClient = Awaited<ReturnType<typeof createCore>>;
