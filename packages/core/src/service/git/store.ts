import { Context, Effect, Layer, Schema } from "effect";
import { AppPathsService } from "../../platform/app-paths.ts";
import { CoreError } from "../errors.ts";
import { readJson, writeJson } from "../json-file.ts";

const ProjectGitSchema = Schema.Struct({
  commonDir: Schema.optionalKey(Schema.NonEmptyString),
  githubRemote: Schema.optionalKey(Schema.NonEmptyString),
});

export const WorktreeStatusSchema = Schema.Literals([
  "creating",
  "ready",
  "removing",
  "removed",
  "needs_reconciliation",
]);

/** Lifecycle receipt of a worktree workspace; Git and the filesystem are re-checked against it. */
export const WorktreeReceiptSchema = Schema.Struct({
  workspaceId: Schema.optionalKey(Schema.NonEmptyString),
  projectId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  /** Worktree root; the workspace cwd adds the project's prefix inside the repository. */
  path: Schema.NonEmptyString,
  prefix: Schema.String,
  commonDir: Schema.String,
  branch: Schema.NonEmptyString,
  createdBranch: Schema.Boolean,
  baseSha: Schema.NonEmptyString,
  /** False for worktrees Eta found already registered; those are never removed by Eta. */
  managed: Schema.Boolean,
  status: WorktreeStatusSchema,
  reason: Schema.optionalKey(Schema.String),
  continues: Schema.optionalKey(Schema.NonEmptyString),
  createdAt: Schema.Number,
  removedAt: Schema.optionalKey(Schema.Number),
}).check(
  Schema.makeFilter(
    (receipt) =>
      receipt.commonDir.length > 0 ||
      (!receipt.managed && receipt.status === "needs_reconciliation"),
    { message: "Only an unverified unmanaged worktree may have an unknown Git identity" },
  ),
);
export type WorktreeReceipt = typeof WorktreeReceiptSchema.Type;

export const GitStoreSchema = Schema.Struct({
  version: Schema.Literal(1),
  projects: Schema.Record(Schema.String, ProjectGitSchema),
  /** Keyed by the create requestId, which stays stable across retries. */
  worktrees: Schema.optionalKey(Schema.Record(Schema.String, WorktreeReceiptSchema)),
  /** Fingerprints of write requests, so a reused requestId with other parameters is a conflict. */
  requests: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type GitStoreState = typeof GitStoreSchema.Type;

/** JSON dictionaries can inherit Object.prototype entries that are not durable records. */
export function gitStoreEntry<A>(
  record: Readonly<Record<string, A>> | undefined,
  key: string,
): A | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

const decode = Schema.decodeUnknownSync(GitStoreSchema);
const empty = (): GitStoreState => ({ version: 1, projects: {} });

/**
 * Git bindings live beside the Catalog rather than in it, so older clients can still read the Catalog.
 * Writes are serialised in-process; the file is only replaced after a complete write.
 */
export class GitStoreService extends Context.Service<
  GitStoreService,
  {
    readonly read: Effect.Effect<GitStoreState, CoreError>;
    update(
      change: (state: GitStoreState) => GitStoreState,
    ): Effect.Effect<GitStoreState, CoreError>;
  }
>()("eta/core/service/git/GitStoreService") {
  static readonly layer = Layer.effect(
    GitStoreService,
    Effect.gen(function* () {
      const { gitStorePath } = yield* AppPathsService;
      let queue = Promise.resolve();
      const validate = (raw: unknown, code: "StorageCorrupt" | "InvalidInput") => {
        try {
          return decode(raw);
        } catch {
          throw new CoreError({
            code,
            message:
              code === "StorageCorrupt" ? `${gitStorePath} 格式无效` : "Git 记录写入不满足存储格式",
          });
        }
      };
      const load = async () => {
        const raw = await readJson(gitStorePath);
        return raw === undefined ? empty() : validate(raw, "StorageCorrupt");
      };
      const read = Effect.tryPromise({
        try: load,
        catch: (error) =>
          error instanceof CoreError
            ? error
            : new CoreError({ code: "StorageUnavailable", message: "无法读取 Git 记录" }),
      });
      return GitStoreService.of({
        read,
        update: (change) =>
          Effect.tryPromise({
            try: () => {
              const next = queue.then(async () => {
                const state = validate(change(await load()), "InvalidInput");
                await writeJson(gitStorePath, state);
                return state;
              });
              queue = next.then(
                () => undefined,
                () => undefined,
              );
              return next;
            },
            catch: (error) =>
              error instanceof CoreError
                ? error
                : new CoreError({ code: "StorageUnavailable", message: "无法保存 Git 记录" }),
          }),
      });
    }),
  );
}
