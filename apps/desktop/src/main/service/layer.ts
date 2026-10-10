import type { ImageProcessor } from "@eta/core/images/types";
import { Effect, Layer } from "effect";
import { coreFoundation, coreDomainServices } from "@eta/core/layer";
import { RuntimeSettingsService } from "@eta/core/service/settings/index";
import { runtimeSettings } from "@eta/core/shared/runtime-settings";
import { CredentialService } from "@eta/core/service/credentials/index";
import { ModelCatalogService } from "./models/index.ts";
import { DesktopSettingsService } from "./settings/index.ts";
import { SkillsService } from "./skills/index.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Desktop supplies its environment and preferences to the shared runtime graph. */
export function desktopServices(
  dataRoot: string,
  modelLayer = ModelCatalogService.layer,
  processImage?: ImageProcessor,
  skillLayer = SkillsService.layer,
) {
  const worker =
    typeof __dirname === "string"
      ? join(__dirname.replace(/app\.asar(?=[/\\])/, "app.asar.unpacked"), "sandbox-worker.cjs")
      : undefined;
  const foundation = CredentialService.layer.pipe(
    Layer.provideMerge(
      coreFoundation(dataRoot, processImage, {
        userAgent: "eta-desktop",
        shutdown: "abortForeground",
        sandboxWorkerPath: worker && existsSync(worker) ? worker : undefined,
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
