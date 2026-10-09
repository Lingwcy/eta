import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ManagedRuntime } from "effect";
import { afterEach } from "vite-plus/test";
import { processImage } from "@eta/core/node/images";
import { ProjectService } from "@eta/core/service/projects/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import { ThreadService } from "@eta/core/service/threads/index";
import { RuntimeRegistryService } from "@eta/core/service/runtime/index";
import { desktopServices } from "../service/layer.ts";
import { ModelCatalogService } from "../service/models/index.ts";
import { DesktopSettingsService } from "../service/settings/index.ts";
import { SkillsService } from "../service/skills/index.ts";

const directories: string[] = [];
const runtimes: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Uses Desktop's real host adapters for IPC and settings integration tests. */
export async function setup(withImages = false) {
  const directory = await mkdtemp(join(tmpdir(), "eta-desktop-integration-"));
  directories.push(directory);
  const cwd = join(directory, "project");
  const skillPath = join(cwd, ".agents", "skills", "review", "SKILL.md");
  await mkdir(join(cwd, ".agents", "skills", "review"), { recursive: true });
  await writeFile(
    skillPath,
    "---\nname: review\ndescription: Review implementation\n---\nREVIEW_INSTRUCTIONS",
  );
  const provider = fauxProvider({
    provider: "eta-test",
    models: [{ id: "one" }],
    tokensPerSecond: 1000,
  });
  const title = fauxProvider({
    provider: "eta-test",
    models: provider.models,
    tokensPerSecond: 1000,
  });
  const models = createModels();
  models.setProvider({
    ...provider.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? title.provider.streamSimple(model, context, options)
        : provider.provider.streamSimple(model, context, options),
  });
  const reopen = () => {
    const runtime = ManagedRuntime.make(
      desktopServices(
        join(directory, "data"),
        ModelCatalogService.layerWith(models),
        withImages ? processImage : undefined,
        SkillsService.layerWith(directory),
      ),
    );
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = reopen();
  const projects = await runtime.runPromise(ProjectService);
  const project = await runtime.runPromise(projects.register({ rootPath: cwd }));
  const workspaces = await runtime.runPromise(WorkspaceService);
  const workspace = (await runtime.runPromise(workspaces.list(project.id)))[0]!;
  const threads = await runtime.runPromise(ThreadService);
  const created = await runtime.runPromise(threads.create(workspace.id));
  const registry = await runtime.runPromise(RuntimeRegistryService);
  const settings = await runtime.runPromise(DesktopSettingsService);
  return {
    directory,
    cwd,
    runtime,
    reopen,
    provider,
    workspace,
    threads,
    registry,
    settings,
    created,
  };
}
