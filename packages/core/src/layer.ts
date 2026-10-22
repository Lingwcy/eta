import { Layer } from "effect";
import type { Models } from "@earendil-works/pi-ai";
import type { ImageProcessor } from "./images/types.ts";
import type { CoreEnvironment } from "./service/environment.ts";
import { CoreEnvironmentService } from "./service/environment.ts";
import { AppPathsService } from "./platform/app-paths.ts";
import { ScheduleDispatcherService } from "./service/schedules/dispatcher.ts";
import { ScheduleStoreService } from "./service/schedules/store.ts";
import { ScheduleGateService } from "./service/schedules/gate.ts";
import { ScheduleLifecycleService } from "./service/schedules/lifecycle.ts";
import { ScheduleService } from "./service/schedules/index.ts";
import { CatalogService } from "./service/catalog/index.ts";
import { CatalogStoreService } from "./service/catalog/json-store.ts";
import { ConversationService } from "./service/conversations/index.ts";
import { ModelCatalogService } from "./service/models/index.ts";
import { ObservationService } from "./service/observation/index.ts";
import { ProjectService } from "./service/projects/index.ts";
import { AgentResourcesService } from "./service/resources/index.ts";
import { RunSupervisorService } from "./service/runs/index.ts";
import { RuntimeRegistryService } from "./service/runtime/index.ts";
import { SessionRepositoryService } from "./service/sessions/index.ts";
import { RuntimeSettingsService } from "./service/settings/index.ts";
import { SkillsService } from "./service/skills/index.ts";
import { ThreadTitleService } from "./service/titles/index.ts";
import { ThreadService } from "./service/threads/index.ts";
import { WorkspaceService } from "./service/workspaces/index.ts";
import { GitRepositoryService } from "./service/git/index.ts";
import { GitStoreService } from "./service/git/store.ts";
import { WorktreeService } from "./service/git/worktrees.ts";
import { WorkspaceAccessService } from "./service/git/workspace-access.ts";
import { GitHubRepositoryService } from "./service/git/github.ts";

export function coreFoundation(
  dataRoot: string,
  processImage?: ImageProcessor,
  environment?: Partial<CoreEnvironment>,
  instructions?: (cwd: string) => Promise<string>,
) {
  const catalog = CatalogService.layer.pipe(Layer.provide(CatalogStoreService.layer));
  return Layer.mergeAll(
    Layer.mergeAll(ScheduleLifecycleService.layer, ScheduleDispatcherService.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(catalog, ScheduleStoreService.layer, ScheduleGateService.layer),
      ),
    ),
    SessionRepositoryService.layer.pipe(Layer.provide(catalog)),
    AgentResourcesService.layerWith(processImage, instructions),
    CoreEnvironmentService.layer(environment),
    WorkspaceAccessService.layer.pipe(Layer.provideMerge(GitStoreService.layer)),
  ).pipe(Layer.provideMerge(AppPathsService.layer(dataRoot, environment?.temporaryWorkspacesRoot)));
}

/** Both applications provide the same domain graph with their own models and settings adapters. */
export function coreDomainServices(skillLayer: ReturnType<typeof SkillsService.layerWith>) {
  const skills = Layer.mergeAll(
    skillLayer,
    ThreadTitleService.layer,
    ScheduleService.layer.pipe(Layer.provideMerge(WorkspaceService.layer)),
  );
  const domain = Layer.mergeAll(
    ProjectService.layer,
    RuntimeRegistryService.layer,
    ConversationService.layer,
    RunSupervisorService.layer,
    ObservationService.layer,
  ).pipe(Layer.provideMerge(skills));
  return Layer.mergeAll(
    ThreadService.layer,
    GitHubRepositoryService.layer.pipe(Layer.provideMerge(GitRepositoryService.layer)),
    WorktreeService.layer,
  ).pipe(Layer.provideMerge(domain));
}

export interface CoreOptions {
  readonly dataRoot: string;
  readonly home: string;
  readonly models: Models;
  readonly settings: RuntimeSettingsService["Service"];
  readonly processImage?: ImageProcessor;
  readonly environment?: Partial<CoreEnvironment>;
  readonly instructions?: (cwd: string) => Promise<string>;
}

export function coreServices(options: CoreOptions) {
  const foundation = coreFoundation(
    options.dataRoot,
    options.processImage,
    options.environment,
    options.instructions,
  );
  const models = ModelCatalogService.layerWith(options.models).pipe(Layer.provideMerge(foundation));
  const settings = Layer.succeed(RuntimeSettingsService, options.settings).pipe(
    Layer.provideMerge(models),
  );
  return coreDomainServices(SkillsService.layerWith(options.home)).pipe(
    Layer.provideMerge(settings),
  );
}
