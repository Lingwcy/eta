import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

/** Run the real Discord SDK against a local Gateway and REST server, including compiled distributions. */
export async function verifyDiscord(DiscordSdk) {
  const tokenEnv = "ETA_BOT_SDK_VERIFIER_TOKEN";
  const previous = process.env[tokenEnv];
  process.env[tokenEnv] = "local-fixture-token";
  const user = { id: "99", username: "Eta", discriminator: "0000", avatar: null, bot: true };
  const channel = {
    id: "10",
    guild_id: "1",
    type: 0,
    name: "issues",
    position: 0,
    permission_overwrites: [],
  };
  const thread = {
    id: "1002",
    guild_id: "1",
    parent_id: "10",
    type: 11,
    name: "Customer issue",
    owner_id: "99",
    message_count: 0,
    member_count: 1,
    thread_metadata: {
      archived: false,
      archive_timestamp: new Date().toISOString(),
      auto_archive_duration: 1440,
      locked: false,
    },
  };
  const message = (id, content, author = user) => ({
    id,
    channel_id: "1002",
    guild_id: "1",
    content,
    author,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    type: 0,
    flags: 0,
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    pinned: false,
    tts: false,
    mention_everyone: false,
  });
  let created = false;
  let gateway;
  let socket;
  let sequence = 1;
  let createCalls = 0;
  let sendBody;
  let rejectSend = false;
  const responses = [];
  const received = Promise.withResolvers();
  let gaps = 0;
  const server = createServer((request, response) => {
    const respond = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const route = request.url.split("?")[0];
      if (route === "/api/v10/gateway/bot")
        return respond(200, {
          url: gateway,
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 1000,
            reset_after: 100000,
            max_concurrency: 1,
          },
        });
      if (route === "/api/v10/channels/10") return respond(200, channel);
      if (route === "/api/v10/channels/10/messages/1002")
        return respond(200, {
          ...message("1002", "Customer question", { ...user, id: "20", bot: false }),
          channel_id: "10",
        });
      if (route === "/api/v10/channels/10/messages/1002/threads") {
        createCalls++;
        created = true;
        return respond(200, thread);
      }
      if (route === "/api/v10/channels/1002/messages") {
        if (request.method === "GET") return respond(200, responses);
        if (rejectSend) return respond(403, { code: 50013, message: "Missing Permissions" });
        sendBody = JSON.parse(body);
        const output = message("10000", sendBody.content);
        responses.push(output);
        return respond(200, output);
      }
      if (route === "/api/v10/channels/1002") {
        if (!created) return respond(404, { code: 10003, message: "Unknown Channel" });
        if (request.method === "PATCH") thread.thread_metadata.archived = JSON.parse(body).archived;
        return respond(200, thread);
      }
      respond(404, { code: 10003, message: "Unknown Channel" });
    });
  });
  const ws = new WebSocketServer({ server });
  const dispatch = (type, data) =>
    socket.send(JSON.stringify({ op: 0, t: type, s: sequence++, d: data }));
  ws.on("connection", (connected) => {
    socket = connected;
    socket.on("error", () => {});
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100000 } }));
    socket.on("message", (bytes) => {
      const buffer = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes);
      const packet = JSON.parse(buffer.toString("utf8"));
      if (packet.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
      if (packet.op === 6) {
        dispatch("RESUMED", {});
        return;
      }
      if (packet.op !== 2) return;
      dispatch("READY", {
        v: 10,
        user,
        guilds: [{ id: "1", unavailable: false }],
        session_id: "local-session",
        resume_gateway_url: gateway,
        application: { id: "99", flags: 0 },
      });
      dispatch("GUILD_CREATE", {
        id: "1",
        name: "Support",
        owner_id: "20",
        unavailable: false,
        roles: [],
        emojis: [],
        members: [],
        channels: [channel],
        threads: [],
        presences: [],
        voice_states: [],
        features: [],
        premium_tier: 0,
        nsfw_level: 0,
        member_count: 0,
        large: false,
        joined_at: new Date().toISOString(),
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  gateway = `ws://127.0.0.1:${address.port}`;
  const sdk = new DiscordSdk(tokenEnv, { api: `http://127.0.0.1:${address.port}/api` });
  try {
    await sdk.start({
      message: async (message) => received.resolve(message),
      gap: async () => {
        gaps++;
      },
    });
    assert.equal(sdk.connected(), true);
    dispatch("MESSAGE_CREATE", {
      ...message("1002", "Customer question", { ...user, id: "20", bot: false }),
      channel_id: "10",
    });
    const source = await received.promise;
    assert.equal(source.guildId, "1");
    assert.equal(source.channelId, "10");
    assert.equal(source.content, "Customer question");
    assert.equal(await sdk.ensureThread(source, "Customer issue"), "1002");
    assert.equal(await sdk.ensureThread(source, "Customer issue"), "1002");
    assert.equal(createCalls, 1);
    assert.equal(await sdk.send("1002", "Answer\n-# eta:fixture", "stable-fixture-nonce"), "10000");
    assert.equal(sendBody.enforce_nonce, true);
    assert.deepEqual(sendBody.allowed_mentions.parse, []);
    responses.unshift(message("10001", "eta:fixture", { ...user, id: "98" }));
    assert.equal(await sdk.findDelivery("1002", "eta:fixture"), "10000");
    assert.equal((await sdk.history("1002", { limit: 10 })).length, 2);
    await sdk.archive("1002", true);
    assert.equal(thread.thread_metadata.archived, true);
    await sdk.archive("1002", false);
    assert.equal(thread.thread_metadata.archived, false);
    rejectSend = true;
    await assert.rejects(
      sdk.send("1002", "Rejected", "other-nonce"),
      (error) => error.retryable === false,
    );
    assert.ok(gaps > 0);
    const resumed = new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const timer = setInterval(() => {
        if (gaps > 1) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error("Gateway resume did not request gap reconciliation."));
        }
      }, 10);
    });
    socket.send(JSON.stringify({ op: 7, d: null }));
    await resumed;
  } finally {
    await sdk.stop();
    for (const socket of ws.clients) socket.terminate();
    await new Promise((resolve) => ws.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = previous;
  }
}
