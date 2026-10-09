import type { ImageProcessor } from "@eta/core/images/types";
import { Effect, Layer } from "effect";
import { coreFoundation, coreDomainServices } from "@eta/core/layer";
import { RuntimeSettingsService } from "@eta/core/service/settings/index";
import { runtimeSettings } from "@eta/core/shared/runtime-settings";
import { CredentialService } from "./credentials/index.ts";
import { ModelCatalogService } from "./models/index.ts";
import { DesktopSettingsService } from "./settings/index.ts";
import { SkillsService } from "./skills/index.ts";

/** Desktop supplies its environment and preferences to the shared runtime graph. */
export function desktopServices(
  dataRoot: string,
  modelLayer = ModelCatalogService.layer,
  processImage?: ImageProcessor,
  skillLayer = SkillsService.layer,
) {
  const foundation = CredentialService.layer.pipe(
    Layer.provideMerge(
      coreFoundation(dataRoot, processImage, {
        userAgent: "eta-desktop",
        shutdown: "abortForeground",
      }),
    ),
  );
  const models = modelLayer.pipe(Layer.provideMerge(foundation));
  const settings = DesktopSettingsService.layer.pipe(Layer.provideMerge(models));
  const preferences = Layer.effect(
    RuntimeSettingsService,
    Effect.map(DesktopSettingsService, (settings) => ({
      read: settings.read.pipe(Effect.map(runtimeSettings)),
      subscribe: (listener: () => void) => settings.subscribe(listener),
    })),
  ).pipe(Layer.provideMerge(settings));
  return coreDomainServices(skillLayer).pipe(Layer.provideMerge(preferences));
}
