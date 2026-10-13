import { Context, Effect, Layer, Schema } from "effect";
import { AppPathsService } from "../../platform/app-paths.ts";
import { CoreError } from "../errors.ts";
import { readJson, writeJson } from "../json-file.ts";

const ProjectGitSchema = Schema.Struct({
  githubRemote: Schema.optionalKey(Schema.NonEmptyString),
});

export const GitStoreSchema = Schema.Struct({
  version: Schema.Literal(1),
  projects: Schema.Record(Schema.String, ProjectGitSchema),
});
export type GitStoreState = typeof GitStoreSchema.Type;

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
      const load = async () => {
        const raw = await readJson(gitStorePath);
        if (raw === undefined) return empty();
        try {
          return decode(raw);
        } catch {
          throw new CoreError({ code: "StorageCorrupt", message: `${gitStorePath} 格式无效` });
        }
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
                const state = change(await load());
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
