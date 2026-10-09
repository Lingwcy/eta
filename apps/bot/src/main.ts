import { serve } from "@hono/node-server";
import { loadBotConfig } from "./config.ts";
import { createBotApplication } from "./application.ts";

const path = process.env.ETA_BOT_CONFIG ?? process.argv[2];
if (!path) throw new Error("Set ETA_BOT_CONFIG or pass the Bot configuration JSON path.");
const config = await loadBotConfig(path);
const application = await createBotApplication(config, {
  log: (event) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event })),
});
const server = serve(
  { fetch: application.app.fetch, hostname: config.host ?? "127.0.0.1", port: config.port ?? 8080 },
  ({ port }) => {
    console.log(`Eta Bot listening on ${config.host ?? "127.0.0.1"}:${port}`);
  },
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const released = application.close().finally(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
  const results = await Promise.allSettled([closed, released]);
  if (results.some((result) => result.status === "rejected")) process.exitCode = 1;
};
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
server.on("error", () => {
  process.exitCode = 1;
  void stop();
});
