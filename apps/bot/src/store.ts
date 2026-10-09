import { DatabaseSync } from "node:sqlite";
import { BotHttpError } from "./errors.ts";

interface RequestRecord {
  payload: string;
  result: string | null;
}

/** SQLite owns short ingress transactions; Core owns the corresponding execution receipts. */
export class BotStore {
  private readonly database: DatabaseSync;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  constructor(path: string) {
    this.database = new DatabaseSync(path, { timeout: 5000 });
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS requests (
        scope TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT,
        PRIMARY KEY (scope, request_id)
      );
    `);
  }

  async request<T>(
    scope: string,
    id: string,
    payload: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    const record = this.database
      .prepare("SELECT payload, result FROM requests WHERE scope=? AND request_id=?")
      .get(scope, id) as RequestRecord | undefined;
    if (record && record.payload !== payload)
      throw new BotHttpError(
        409,
        "RequestConflict",
        "This request ID belongs to a different payload.",
      );
    if (record?.result !== null && record?.result !== undefined)
      return JSON.parse(record.result) as T;
    const key = JSON.stringify([scope, id]);
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;
    this.database
      .prepare("INSERT OR IGNORE INTO requests (scope, request_id, payload) VALUES (?, ?, ?)")
      .run(scope, id, payload);
    const execution = Promise.resolve()
      .then(execute)
      .then((result) => {
        this.database
          .prepare("UPDATE requests SET result=? WHERE scope=? AND request_id=?")
          .run(JSON.stringify(result), scope, id);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, execution);
    return execution;
  }

  async close() {
    await Promise.allSettled(this.inFlight.values());
    this.database.close();
  }
}

/** An OS-backed SQLite write lock is released on process death, including container restarts. */
export function lockDataRoot(path: string) {
  const database = new DatabaseSync(path, { timeout: 0 });
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch {
    database.close();
    throw new Error("Another Bot process is already using this data root.");
  }
  return () => database.close();
}
