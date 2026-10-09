import type { Extension } from "@eta/agent";
import type { CoreClient } from "@eta/core";
import type { Hono } from "hono";
import type { BotController } from "./controller.ts";
import type { BotLog } from "./log.ts";

export interface BotExtension {
  readonly name: string;
  runtimeExtensions(): readonly Extension[];
  initialize(context: {
    core: CoreClient;
    controller: BotController;
    workspaces: ReadonlyMap<string, string>;
    log: BotLog;
  }): void;
  mount(app: Hono): void;
  status(): unknown;
  prepareRecovery(): Promise<void>;
  start(): Promise<void>;
  stopIngress(): Promise<void>;
  close(): Promise<void>;
}

/** Explicit application registration; runtime definitions exist before any Harness is opened. */
export class BotExtensions {
  constructor(private readonly installed: readonly BotExtension[]) {}
  runtimeExtensions() {
    return this.installed.flatMap((extension) => extension.runtimeExtensions());
  }
  initialize(context: Parameters<BotExtension["initialize"]>[0]) {
    for (const extension of this.installed) extension.initialize(context);
  }
  mount(app: Hono) {
    for (const extension of this.installed) extension.mount(app);
  }
  status() {
    return Object.fromEntries(
      this.installed.map((extension) => [extension.name, extension.status()]),
    );
  }
  async prepareRecovery() {
    for (const extension of this.installed) await extension.prepareRecovery();
  }
  async start() {
    for (const extension of this.installed) await extension.start();
  }
  async stopIngress() {
    await Promise.allSettled(this.installed.map((extension) => extension.stopIngress()));
  }
  async close() {
    const results = await Promise.allSettled(this.installed.map((extension) => extension.close()));
    if (results.some((result) => result.status === "rejected"))
      throw new Error("An extension could not release its resources.");
  }
}
