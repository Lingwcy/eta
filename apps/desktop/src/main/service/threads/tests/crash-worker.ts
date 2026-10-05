import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ManagedRuntime } from "effect";
import { desktopServices } from "../../layer.ts";
import { ModelCatalogService } from "../../models/index.ts";
import { ProjectService } from "../../projects/index.ts";
import { RuntimeRegistryService } from "../../runtime/index.ts";
import { WorkspaceService } from "../../workspaces/index.ts";
import { ThreadService } from "../index.ts";

// A real child process: the parent kills it after the first persisted streaming revision.
const [dataRoot, cwd] = process.argv.slice(2);
if (!dataRoot || !cwd || !process.send) throw new Error("Crash fixture requires paths and IPC");
const provider = fauxProvider({
  provider: "eta-test",
  models: [{ id: "one" }],
  tokensPerSecond: 2,
});
provider.setResponses([fauxAssistantMessage("A deliberately unfinished response ".repeat(100))]);
const models = createModels();
const titleProvider = fauxProvider({ provider: "eta-test", models: [{ id: "one" }] });
models.setProvider({
  ...provider.provider,
  streamSimple: (model, context, options) =>
    options?.sessionId?.endsWith(":title")
      ? titleProvider.provider.streamSimple(model, context, options)
      : provider.provider.streamSimple(model, context, options),
});
const runtime = ManagedRuntime.make(
  desktopServices(dataRoot, ModelCatalogService.layerWith(models)),
);
const projects = await runtime.runPromise(ProjectService);
const project = await runtime.runPromise(projects.register({ rootPath: cwd }));
const workspaces = await runtime.runPromise(WorkspaceService);
const workspace = (await runtime.runPromise(workspaces.list(project.id)))[0]!;
const threads = await runtime.runPromise(ThreadService);
const created = await runtime.runPromise(threads.create(workspace.id));
const registry = await runtime.runPromise(RuntimeRegistryService);
const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
const watch = await record.conversation.watch(BACKGROUND_CONTEXT);
let reported = false;
watch.start(async (view) => {
  if (!reported && JSON.stringify(view.docs["pi.live"]).includes("message")) {
    reported = true;
    process.send?.({ thread: created.thread });
  }
});
await runtime.runPromise(threads.submit(created.id, "Resume me without adding a second prompt"));
