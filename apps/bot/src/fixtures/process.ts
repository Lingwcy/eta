import { serve } from "@hono/node-server";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createBotApplication } from "../application.ts";
import { loadBotConfig } from "../config.ts";

const config = await loadBotConfig(process.argv[2]!);
const provider = fauxProvider({
  provider: "process-test",
  models: [{ id: "one" }],
  tokensPerSecond: 10000,
});
const titles = fauxProvider({
  provider: "process-test",
  models: [{ id: "one" }],
  tokensPerSecond: 10000,
});
const models = createModels();
models.setProvider({
  ...provider.provider,
  streamSimple: (model, context, options) =>
    options?.sessionId?.endsWith(":title")
      ? titles.provider.streamSimple(model, context, options)
      : provider.provider.streamSimple(model, context, options),
});
provider.setResponses(
  process.argv[3] === "hold"
    ? [
        fauxAssistantMessage(
          fauxToolCall("write", { path: "process-result.txt", content: "Written before SIGKILL" }),
          { stopReason: "toolUse" },
        ),
        (_context, options) =>
          new Promise((resolve) => {
            process.send?.({ event: "waiting" });
            options?.signal?.addEventListener(
              "abort",
              () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
              { once: true },
            );
          }),
      ]
    : [fauxAssistantMessage("Recovered after SIGKILL")],
);
const application = await createBotApplication(config, { models });
const server = serve({ fetch: application.app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) =>
  process.send?.({ event: "listening", port }),
);
process.once("SIGTERM", async () => {
  server.close();
  await application.close();
  process.disconnect();
});
