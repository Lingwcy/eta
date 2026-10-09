import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { MessageSchema } from "./types.ts";
import type { DiscordMessage, IssueState } from "./types.ts";

const IssueSchema = Schema.Struct({
  id: Schema.String,
  source: MessageSchema,
  projectKey: Schema.String,
  etaThreadId: Schema.NullOr(Schema.String),
  discordThreadId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["queued", "working", "waiting", "failed", "review", "stopped", "closed"]),
  error: Schema.NullOr(Schema.String),
  archivePending: Schema.Boolean,
});
export type Issue = typeof IssueSchema.Type;
const InboxSchema = Schema.Struct({
  id: Schema.String,
  issueId: Schema.String,
  message: MessageSchema,
  state: Schema.Literals(["queued", "admitted", "done", "cancelled", "blocked"]),
  operationId: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  taskAttempt: Schema.Int,
  error: Schema.NullOr(Schema.String),
});
export type Inbox = typeof InboxSchema.Type;
const OutboxSchema = Schema.Struct({
  id: Schema.String,
  inboxId: Schema.String,
  issueId: Schema.String,
  threadId: Schema.String,
  content: Schema.String,
  marker: Schema.String,
  nonce: Schema.String,
  state: Schema.Literals(["pending", "sending", "sent", "review", "failed"]),
  remoteId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type Outbox = typeof OutboxSchema.Type;
const Row = Schema.Struct({ data: Schema.String });

/** Ingress and delivery records are separate from Core's execution log; stable IDs reconcile their commits. */
export class DiscordStore {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path, { timeout: 5000 });
    this.database.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_issue ON inbox(json_extract(data, '$.issueId'), json_extract(data, '$.state'));
      CREATE INDEX IF NOT EXISTS inbox_state ON inbox(json_extract(data, '$.state'));
      CREATE INDEX IF NOT EXISTS outbox_input ON outbox(json_extract(data, '$.inboxId'));
      CREATE INDEX IF NOT EXISTS issue_thread ON issues(json_extract(data, '$.discordThreadId'), json_extract(data, '$.source.guildId'));
    `);
  }
  private list<A>(
    table: "issues" | "inbox" | "outbox",
    schema: Schema.ConstraintDecoder<A>,
    where = "",
    parameters: readonly string[] = [],
  ) {
    const order = table === "issues" ? "id" : "seq";
    return this.database
      .prepare(`SELECT data FROM ${table} ${where} ORDER BY ${order}`)
      .all(...parameters)
      .map((row) =>
        Schema.decodeUnknownSync(schema)(JSON.parse(Schema.decodeUnknownSync(Row)(row).data)),
      );
  }
  issues() {
    return this.list("issues", IssueSchema);
  }
  pumpIssues() {
    return this.list(
      "issues",
      IssueSchema,
      "WHERE json_extract(data, '$.archivePending')=1 OR id IN (SELECT json_extract(data, '$.issueId') FROM inbox WHERE json_extract(data, '$.state') IN ('queued', 'admitted'))",
    );
  }
  inputs(issueId?: string) {
    return this.list(
      "inbox",
      InboxSchema,
      issueId === undefined ? "" : "WHERE json_extract(data, '$.issueId')=?",
      issueId === undefined ? [] : [issueId],
    );
  }
  pendingInputs(issueId: string) {
    return this.list(
      "inbox",
      InboxSchema,
      "WHERE json_extract(data, '$.issueId')=? AND json_extract(data, '$.state') IN ('queued', 'admitted', 'blocked')",
      [issueId],
    );
  }
  outputs(inboxId?: string) {
    return this.list(
      "outbox",
      OutboxSchema,
      inboxId === undefined ? "" : "WHERE json_extract(data, '$.inboxId')=?",
      inboxId === undefined ? [] : [inboxId],
    );
  }
  private get<A>(
    table: "issues" | "inbox" | "outbox",
    id: string,
    schema: Schema.ConstraintDecoder<A>,
  ) {
    const row = this.database.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return row === undefined
      ? undefined
      : Schema.decodeUnknownSync(schema)(JSON.parse(Schema.decodeUnknownSync(Row)(row).data));
  }
  issue(id: string) {
    return this.get("issues", id, IssueSchema);
  }
  issueForThread(guildId: string, threadId: string) {
    return this.list(
      "issues",
      IssueSchema,
      "WHERE json_extract(data, '$.discordThreadId')=? AND json_extract(data, '$.source.guildId')=?",
      [threadId, guildId],
    )[0];
  }
  input(id: string) {
    return this.get("inbox", id, InboxSchema);
  }
  delivery(id: string) {
    return this.get("outbox", id, OutboxSchema);
  }
  updateIssue(id: string, patch: Partial<Omit<Issue, "id">>) {
    const issue = this.issue(id);
    if (!issue) throw new Error("Discord issue is missing.");
    this.database
      .prepare("UPDATE issues SET data=? WHERE id=?")
      .run(JSON.stringify({ ...issue, ...patch }), id);
  }
  updateInput(id: string, patch: Partial<Omit<Inbox, "id">>) {
    const input = this.input(id);
    if (!input) throw new Error("Discord input is missing.");
    this.database
      .prepare("UPDATE inbox SET data=? WHERE id=?")
      .run(JSON.stringify({ ...input, ...patch }), id);
  }
  output(record: Outbox) {
    this.database
      .prepare("INSERT OR IGNORE INTO outbox (id, data) VALUES (?, ?)")
      .run(record.id, JSON.stringify(record));
  }
  updateOutput(id: string, patch: Partial<Omit<Outbox, "id">>) {
    const record = this.delivery(id);
    if (!record) throw new Error("Discord delivery is missing.");
    this.database
      .prepare("UPDATE outbox SET data=? WHERE id=?")
      .run(JSON.stringify({ ...record, ...patch }), id);
  }
  accept(message: DiscordMessage, issueId: string, projectKey?: string) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (projectKey !== undefined) {
        const issue: Issue = {
          id: issueId,
          source: message,
          projectKey,
          etaThreadId: null,
          discordThreadId: null,
          state: "queued",
          error: null,
          archivePending: false,
        };
        this.database
          .prepare("INSERT OR IGNORE INTO issues (id, data) VALUES (?, ?)")
          .run(issueId, JSON.stringify(issue));
      }
      const input: Inbox = {
        id: message.id,
        issueId,
        message,
        state: "queued",
        operationId: null,
        taskId: null,
        taskAttempt: 0,
        error: null,
      };
      const result = this.database
        .prepare("INSERT OR IGNORE INTO inbox (id, data) VALUES (?, ?)")
        .run(message.id, JSON.stringify(input));
      this.database.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  cursor(channelId: string) {
    const row = this.database.prepare("SELECT data FROM cursors WHERE id=?").get(channelId);
    return row === undefined ? undefined : Schema.decodeUnknownSync(Row)(row).data;
  }
  advance(channelId: string, messageId: string) {
    const current = this.cursor(channelId);
    if (current === undefined || BigInt(messageId) > BigInt(current))
      this.database
        .prepare(
          "INSERT INTO cursors (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(channelId, messageId);
  }
  setState(id: string, state: IssueState) {
    this.updateIssue(id, { state, error: null });
  }
  close() {
    this.database.close();
  }
}
