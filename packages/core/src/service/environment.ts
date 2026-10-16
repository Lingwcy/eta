import { Context, Layer } from "effect";
import { SandboxedExecutionEnv } from "../platform/sandbox/environment.ts";
import type { SandboxMode, SandboxPolicy } from "../shared/sandbox.ts";
import { sandboxModes } from "../shared/sandbox.ts";
import type { ExecutionEnv } from "@eta/agent/env";
import type { Extension } from "@eta/agent";
import type { Models } from "@earendil-works/pi-ai";
import type { EtaSessionMetadata } from "../shared/sessions.ts";
import type { GitHubAdapter } from "../platform/github.ts";

export interface CoreEnvironment {
  readonly github?: GitHubAdapter;
  readonly userAgent: string;
  readonly authorizeScheduleWorkspace: (workspaceId: string) => Promise<void>;
  readonly shutdown: "preserve" | "abortForeground";
  readonly executionEnvironment: (
    cwd: string,
    policy: SandboxPolicy,
  ) => ExecutionEnv | Promise<ExecutionEnv>;
  readonly allowedSandboxModes: readonly SandboxMode[];
  readonly sandboxWorkerPath?: string;
  readonly codemodeAssets?: { worker: string; wasm: string };
  /** Where Eta creates managed worktrees; defaults to a sibling `<dataRoot>-worktrees` directory. */
  readonly worktreeRoot?: string;
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
      authorizeScheduleWorkspace: options.authorizeScheduleWorkspace ?? (async () => {}),
      github: options.github,
      shutdown: options.shutdown ?? "preserve",
      allowedSandboxModes: options.allowedSandboxModes ?? sandboxModes,
      sandboxWorkerPath: options.sandboxWorkerPath,
      codemodeAssets: options.codemodeAssets,
      ...(options.worktreeRoot ? { worktreeRoot: options.worktreeRoot } : {}),
      executionEnvironment:
        options.executionEnvironment ??
        ((_cwd, policy) =>
          SandboxedExecutionEnv.open(policy, { workerPath: options.sandboxWorkerPath })),
      extensions: options.extensions ?? (() => []),
    });
}
