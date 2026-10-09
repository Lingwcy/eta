import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { serve } from "@hono/node-server";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Schema } from "effect";
import { createBotApplication } from "../../../src/application.ts";
import { loadBotConfig } from "../../../src/config.ts";
import type { DiscordPort } from "../types.ts";
import { MessageSchema } from "../types.ts";

const config = await loadBotConfig(process.argv[2]!);
const phase = process.argv[3];
const remote = new DatabaseSync(join(dirname(process.argv[2]!), "remote.sqlite"));
remote.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, data TEXT NOT NULL);",
);
const row = Schema.Struct({ data: Schema.String });
const source = {
  id: "1002",
  guildId: "1",
  channelId: "10",
  authorId: "20",
  bot: false,
  content: "issue: investigate",
  createdAt: 1002,
};
function halt(at: string) {
  if (phase !== at) return;
  process.send?.({ event: "halted", phase: at });
  process.kill(process.pid, "SIGSTOP");
}
let online = false;
const port: DiscordPort = {
  start: async () => {
    online = true;
  },
  stop: async () => {
    online = false;
  },
  connected: () => online,
  ensureThread: async (source) => {
    remote.prepare("INSERT OR IGNORE INTO threads(id) VALUES (?)").run(source.id);
    halt("thread");
    return source.id;
  },
  history: async (channel, options) =>
    remote
      .prepare("SELECT data FROM messages")
      .all()
      .map((value) =>
        Schema.decodeUnknownSync(MessageSchema)(
          JSON.parse(Schema.decodeUnknownSync(row)(value).data),
        ),
      )
      .filter(
        (message) =>
          message.channelId === channel &&
          (!options.before || BigInt(message.id) < BigInt(options.before)),
      )
      .toSorted((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
      .slice(0, options.limit),
  send: async (thread, content, _nonce) => {
    const message = {
      ...source,
      id: "10000",
      channelId: thread,
      authorId: "99",
      bot: true,
      content,
    };
    remote
      .prepare("INSERT OR IGNORE INTO messages(id, data) VALUES (?, ?)")
      .run(message.id, JSON.stringify(message));
    halt("send");
    return message.id;
  },
  findDelivery: async (thread, marker) => {
    const messages = await port.history(thread, { limit: 100 });
    return messages.find((message) => message.bot && message.content.includes(marker))?.id;
  },
  archive: async () => {},
};
const provider = fauxProvider({
  provider: "discord-process",
  models: [{ id: "one" }],
  tokensPerSecond: 10000,
});
const titles = fauxProvider({
  provider: "discord-process",
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
const final =
  phase === "execute" || phase === "stop"
    ? (_context: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
          if (phase === "stop") process.send?.({ event: "ready-stop" });
          else halt("execute");
          options?.signal?.addEventListener(
            "abort",
            () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
        })
    : fauxAssistantMessage("Durable customer reply");
provider.setResponses(
  existsSync(join(config.projects[0]!.rootPath, "crash-proof.txt"))
    ? [fauxAssistantMessage("Recovered customer reply")]
    : [
        fauxAssistantMessage(
          fauxToolCall("write", { path: "crash-proof.txt", content: "Investigated before reply" }),
          { stopReason: "toolUse" },
        ),
        final,
      ],
);
const application = await createBotApplication(config, { models, discordPort: port });
const create = application.core.createThread;
application.core.createThread = async (...args) => {
  const created = await create(...args);
  halt("create");
  return created;
};
const output = application.discord!.store.output.bind(application.discord!.store);
application.discord!.store.output = (record) => {
  output(record);
  halt("result");
};
const stop = application.controller.stop.bind(application.controller);
application.controller.stop = async (id) => {
  halt("stop");
  await stop(id);
};
serve({ fetch: application.app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) =>
  process.send?.({ event: "listening", port }),
);
process.on("message", (value) => {
  if (value !== "work") return;
  remote
    .prepare("INSERT OR IGNORE INTO messages(id, data) VALUES (?, ?)")
    .run(source.id, JSON.stringify(source));
  void application.discord!.receive(source).catch((error: unknown) =>
    process.send?.({
      event: "failure",
      message: error instanceof Error ? error.message : "Unknown failure",
    }),
  );
});
