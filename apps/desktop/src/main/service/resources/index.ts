import type { Models } from "@earendil-works/pi-ai";
import type { ImageProcessor } from "../../../images/types.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@eta/agent";
import { CodingTools, createReadTool } from "@eta/agent/tools";
import { Context, Effect, Layer } from "effect";
import { adapter } from "../errors.ts";
import type { DesktopServiceError } from "../errors.ts";

export class AgentResourcesService extends Context.Service<
  AgentResourcesService,
  {
    readonly processImage?: ImageProcessor;
    registry(models?: Models): ReturnType<typeof createRegistry>;
    instructions(cwd: string): Effect.Effect<string, DesktopServiceError>;
  }
>()("eta/desktop/main/service/resources/AgentResourcesService") {
  static readonly layerWith = (processImage?: ImageProcessor) =>
    Layer.succeed(
      AgentResourcesService,
      AgentResourcesService.of({
        processImage,
        registry: (models) => {
          const registry = createRegistry();
          registry.install(
            processImage
              ? {
                  ...CodingTools,
                  tools: [
                    ...(CodingTools.tools ?? []).filter((tool) => tool.name !== "read"),
                    createReadTool({
                      readImage: async (bytes, _mimeType, api, context) => {
                        const agent = await api.agent(context);
                        const model =
                          agent.model &&
                          models?.getModel(agent.model.provider, agent.model.modelId);
                        const image = await processImage(
                          bytes,
                          "tool image",
                          model?.inputLimits?.images?.resize,
                        );
                        return [
                          { type: "image", data: image.data, mimeType: image.mimeType },
                          ...(image.note ? [{ type: "text" as const, text: image.note }] : []),
                          ...(model && !model.input.includes("image")
                            ? [
                                {
                                  type: "text" as const,
                                  text: "Current model does not support images.",
                                },
                              ]
                            : []),
                        ];
                      },
                    }),
                  ],
                }
              : CodingTools,
          );
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
  static readonly layer = AgentResourcesService.layerWith();
}
