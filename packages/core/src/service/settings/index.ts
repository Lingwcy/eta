import { Context, Effect } from "effect";
import type { RuntimeSettings } from "../../shared/runtime-settings.ts";

/** Hosts own persistence and publish runtime preference changes to open threads. */
export class RuntimeSettingsService extends Context.Service<
  RuntimeSettingsService,
  {
    readonly read: Effect.Effect<RuntimeSettings>;
    subscribe(listener: () => void): () => void;
  }
>()("eta/core/service/settings/RuntimeSettingsService") {}
