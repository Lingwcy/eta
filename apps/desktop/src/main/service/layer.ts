import { Layer } from "effect";
import { AppPathsService } from "../platform/app-paths.ts";
import { DesktopCatalogService } from "./catalog/index.ts";
import { CatalogStoreService } from "./catalog/json-store.ts";
import { ConversationService } from "./conversations/index.ts";
import { CredentialService } from "./credentials/index.ts";
import { ModelCatalogService } from "./models/index.ts";
import { ObservationService } from "./observation/index.ts";
import { ProjectService } from "./projects/index.ts";
import { AgentResourcesService } from "./resources/index.ts";
import { RunSupervisorService } from "./runs/index.ts";
import { RuntimeRegistryService } from "./runtime/index.ts";
import { SessionRepositoryService } from "./sessions/index.ts";
import { DesktopSettingsService } from "./settings/index.ts";
import { ThreadService } from "./threads/index.ts";
import { WorkspaceService } from "./workspaces/index.ts";

/** One memoized service graph per application; no Electron imports below bootstrap. */
export function desktopServices(dataRoot: string, modelLayer = ModelCatalogService.layer) {
  const paths = AppPathsService.layer(dataRoot);
  const catalog = DesktopCatalogService.layer.pipe(Layer.provide(CatalogStoreService.layer));
  const foundation = Layer.mergeAll(
    catalog,
    CredentialService.layer,
    DesktopSettingsService.layer,
    SessionRepositoryService.layer,
    AgentResourcesService.layer,
  ).pipe(Layer.provideMerge(paths));
  const models = modelLayer.pipe(Layer.provideMerge(foundation));
  const domain = Layer.mergeAll(
    ProjectService.layer,
    WorkspaceService.layer,
    RuntimeRegistryService.layer,
    ConversationService.layer,
    RunSupervisorService.layer,
    ObservationService.layer,
  ).pipe(Layer.provideMerge(models));
  return ThreadService.layer.pipe(Layer.provideMerge(domain));
}
