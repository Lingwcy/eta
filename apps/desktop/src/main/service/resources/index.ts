import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@eta/agent";
import { CodingTools } from "@eta/agent/tools";
import { Context, Effect, Layer } from "effect";
import { adapter } from "../errors.ts";
import type { DesktopServiceError } from "../errors.ts";

export class AgentResourcesService extends Context.Service<
  AgentResourcesService,
  {
    registry(): ReturnType<typeof createRegistry>;
    instructions(cwd: string): Effect.Effect<string, DesktopServiceError>;
  }
>()("eta/desktop/main/service/resources/AgentResourcesService") {
  static readonly layer = Layer.succeed(
    AgentResourcesService,
    AgentResourcesService.of({
      registry: () => {
        const registry = createRegistry();
        registry.install(CodingTools);
        return registry;
      },
      instructions: (cwd) =>
        adapter("无法读取项目 AGENTS.md", async () => {
          let project = "";
          try {
            project = await readFile(join(cwd, "AGENTS.md"), "utf8");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
          return `You are Eta, a coding agent. Work in ${cwd}. Answer in the user's language.\n${project}`;
        }),
    }),
  );
}
