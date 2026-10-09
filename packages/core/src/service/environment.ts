import { Context, Layer } from "effect";
import { NodeExecutionEnv } from "@eta/agent/env/node";
import type { ExecutionEnv } from "@eta/agent/env";
import type { Extension } from "@eta/agent";
import type { Models } from "@earendil-works/pi-ai";
import type { EtaSessionMetadata } from "../shared/sessions.ts";

export interface CoreEnvironment {
  readonly userAgent: string;
  readonly shutdown: "preserve" | "abortForeground";
  readonly executionEnvironment: (cwd: string) => ExecutionEnv | Promise<ExecutionEnv>;
  readonly extensions: (
    ref: EtaSessionMetadata,
    models: Models,
  ) => readonly Extension[] | Promise<readonly Extension[]>;
}

/** Environment capabilities belong to one host instance, never process-global defaults. */
export class CoreEnvironmentService extends Context.Service<
  CoreEnvironmentService,
  CoreEnvironment
>()("eta/core/service/CoreEnvironmentService") {
  static readonly layer = (options: Partial<CoreEnvironment> = {}) =>
    Layer.succeed(CoreEnvironmentService, {
      userAgent: options.userAgent ?? "eta",
      shutdown: options.shutdown ?? "preserve",
      executionEnvironment:
        options.executionEnvironment ?? ((cwd) => new NodeExecutionEnv({ cwd })),
      extensions: options.extensions ?? (() => []),
    });
}
