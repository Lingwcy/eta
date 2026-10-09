# Eta Bot

Eta Bot hosts Core over HTTP and can receive customer issues from Discord. It keeps its own projects, threads, credentials and execution state; Desktop data does not synchronize with it.

Use Node.js 24 and the repository's Vite+ toolchain:

```sh
vp install
vp run @eta/bot#build
vp run @eta/bot#verify-package
cp apps/bot/config.example.json apps/bot/config.json
node apps/bot/dist/main.mjs apps/bot/config.json
```

Edit the configuration before starting. Set a private administrator token, an existing project directory, the provider/model you want to use, and the environment variable containing its API key. Relative paths resolve against the configuration file. Credential mappings contain environment variable names, never API key values. `home` defaults to `dataRoot/home`, and controls personal skill discovery. The server defaults to `127.0.0.1:8080`. `maxConcurrent` limits active threads; threads sharing a project serialize access to its checkout. `shutdownGraceMs` allows a bounded finish window before preserving outstanding work (default 250 ms, maximum 10 seconds).

Query `GET /v1/workspaces` with `Authorization: Bearer <adminToken>`, then create a thread with `POST /v1/threads` and a JSON body containing `workspaceId` and `requestId`. Submit work with `POST /v1/threads/:id/messages`, containing `prompt` and a new `requestId`. A `202` response means the input was saved; use its `operationId` with `GET /v1/threads/:id/operations/:operationId` to read the final result. Retry the same request ID and payload after a network failure. A different payload with that ID returns `409`. A Busy response means the input was not admitted and may be retried later.

`GET /v1/threads/:id/events` streams current snapshots through SSE. Reconnection reads the latest snapshot; it does not replay every event. Disconnecting a client leaves execution running. `POST /v1/threads/:id/stop` cancels work, while `/resume` explicitly resumes paused work. Process shutdown preserves work, and safe pending work resumes at startup. Interrupted tools with uncertain side effects and missing task definitions require maintainer review; inspect `GET /v1/status` before choosing resume or stop. Blocked recovery reserves the project's checkout until addressed.

For Linux deployment, build the distribution first, copy the example configuration to `apps/bot/config.json`, and prepare `apps/bot/workspaces/support`. Then run:

```sh
docker compose -f apps/bot/compose.example.yaml up --build -d
```

With Docker available, `vp run @eta/bot#verify-container` builds an isolated test image and verifies the Linux HTTP/SSE server, shutdown, persistent-volume restart, Git/Bash availability and bundled image decoding. The Bot CI workflow runs this check on Ubuntu alongside Core and Bot tests.

The image runs as the `node` user (UID 1000); the mounted project must be writable by that user. Git, Bash and CA certificates are included. Expose the loopback port through your HTTPS reverse proxy when accessing it remotely. Mount configuration read-only and supply provider keys through the deployment environment. The image copies the complete `dist` directory and needs no workspace dependencies at runtime. Use one replica per data root; SQLite enforces the writer lock.

Back up the entire data volume after stopping the Bot, including Catalog/session files, `bot.sqlite` and `discord.sqlite` when using Discord. Keep the project checkout in a separate backup if work must be recoverable. Restore the complete data directory and project at the same paths, retain the same configuration and credential mappings, then start the Bot and inspect `/v1/status`. Copying only session files loses request deduplication, issue associations and delivery state. In-flight unsafe tools may require review after restoration.

## Discord issues

Add this section to your configuration, replacing IDs and the project key:

```json
{
  "discord": {
    "tokenEnv": "DISCORD_BOT_TOKEN",
    "backfillLimit": 100,
    "channels": [
      {
        "guildId": "123456789012345678",
        "channelId": "234567890123456789",
        "projectKey": "support",
        "triggerPrefix": "issue:"
      }
    ]
  }
}
```

Set the bot token in `DISCORD_BOT_TOKEN`. Enable **Message Content Intent** in the Discord developer portal; the Bot requests Guilds, Guild Messages and Message Content. Grant View Channel, Read Message History, Send Messages, Create Public Threads and Send Messages in Threads. Additional thread permissions may be needed when reopening locked threads. The initial integration supports ordinary guild text channels. Forum posts are outside this version's scope. [Discord Gateway documentation](https://docs.discord.com/developers/events/gateway).

An eligible message creates one Discord thread and one Eta thread. Later messages in that Discord thread reuse the Eta thread and queue behind its current investigation. Bot-authored messages are ignored. The default workflow investigates and replies; publishing, pushing code and opening a PR require a separately authorized maintenance workflow. Replies come from persisted operation results and are split into bounded messages, with no token-by-token progress posts.

On first start a channel begins at the startup timestamp. Set `startAfter` to a Discord message ID when you intentionally want earlier messages included. Restarts and Gateway reconnects inspect configured channels and active issue threads; a periodic scan also covers gaps during thread creation. Each scan is bounded by `backfillLimit`. `limitedBackfill` identifies scans that could not reach the previous cursor, which remains unacknowledged; increase the limit and restart to inspect more history. Deleted or inaccessible messages cannot be recovered. History scans require Read Message History permission.

Use the authenticated `GET /v1/extensions/discord` or `GET /v1/status` to inspect connection state, queued inputs, issue states and deliveries. Issue states distinguish investigation (`working`), waiting for another customer message (`waiting`), failed execution (`failed`), maintainer review (`review`), stopped and closed. Control an issue with `POST /v1/extensions/discord/issues/:sourceMessageId/stop`, `/resume`, `/close` or `/reopen`. Stop cancels current and queued inputs; resume allows new work and retries blocked admission, while preserving the original model operation when retrying a failed reply task. Close also archives the Discord thread, and reopen continues the same Eta thread. Core's own archive state remains separate.

For a delivery in `review`, inspect the corresponding Discord thread, then call `POST /v1/extensions/discord/deliveries/:deliveryId/retry` to explicitly authorize another attempt. The Bot first looks for its stable message marker. If it finds the reply, it records delivery; otherwise it retries. Unknown network outcomes are inspected before another send, and an inconclusive history lookup waits for review. A Discord nonce provides short-term duplicate protection, while saved message IDs and markers support longer-lived reconciliation; this does not guarantee end-to-end exactly-once delivery. [Discord message API](https://docs.discord.com/developers/resources/message#create-message).

Set `discord.enabled` to `false` to pause reception and delivery while keeping durable task definitions installed. Pending work remains available for a later restart with the extension enabled. Removing the entire Discord configuration can leave existing tasks without definitions; the Bot blocks their recovery until the extension is restored or the work is explicitly stopped.

The process emits JSON records for operation admission, recovery, Discord input and delivery. Thread, request, operation, issue and delivery IDs correlate the records; prompt contents and credential values are omitted. A Discord connection failure is reported separately and leaves the HTTP maintenance interface available.
