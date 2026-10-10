import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect";
import { AppPathsService } from "../../platform/app-paths.ts";
import { adapter, CoreError } from "../errors.ts";
import { readJson, writeJson } from "../json-file.ts";

export const CredentialSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("api_key"),
    key: Schema.optionalKey(Schema.NonEmptyString),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    refresh: Schema.NonEmptyString,
    access: Schema.NonEmptyString,
    expires: Schema.Number,
  }),
]);
const FileSchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Record(Schema.String, CredentialSchema),
});

export class CredentialService extends Context.Service<
  CredentialService,
  {
    readonly store: CredentialStore;
    readonly list: Effect.Effect<
      ReadonlyArray<{ providerId: string; type: Credential["type"] }>,
      CoreError
    >;
    setApiKey(providerId: string, key: string): Effect.Effect<void, CoreError>;
    remove(providerId: string): Effect.Effect<void, CoreError>;
    export: Effect.Effect<Record<string, Credential>>;
    import(values: unknown): Effect.Effect<void, CoreError>;
    importOnce(source: CredentialStore): Effect.Effect<void, CoreError>;
  }
>()("eta/core/service/credentials/CredentialService") {
  static readonly layer = Layer.effect(
    CredentialService,
    Effect.gen(function* () {
      const { dataRoot } = yield* AppPathsService;
      const path = join(dataRoot, "credentials.json");
      const raw = yield* adapter("无法读取认证信息", () => readJson(path));
      const initial =
        raw === undefined
          ? {}
          : yield* Effect.gen(function* () {
              yield* Schema.decodeUnknownEffect(FileSchema)(raw).pipe(
                Effect.mapError(
                  () =>
                    new CoreError({
                      code: "StorageCorrupt",
                      message: "认证文件格式或版本无效",
                    }),
                ),
              );
              const source = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ credentials: Schema.Record(Schema.String, Schema.Unknown) }),
              )(raw).pipe(
                Effect.mapError(
                  () =>
                    new CoreError({
                      code: "StorageCorrupt",
                      message: "认证文件格式无效",
                    }),
                ),
              );
              // Required fields were validated above; retain provider-specific OAuth fields on disk.
              return source.credentials as Record<string, Credential>;
            });
      const state = yield* SynchronizedRef.make<Record<string, Credential>>(initial);
      // pi-ai refreshes OAuth inside modify; the same lock also covers login and logout.
      const store: CredentialStore = {
        read: async (provider, options) => {
          options?.signal?.throwIfAborted();
          return structuredClone((await Effect.runPromise(SynchronizedRef.get(state)))[provider]);
        },
        list: async (options) => {
          options?.signal?.throwIfAborted();
          return Object.entries(await Effect.runPromise(SynchronizedRef.get(state))).map(
            ([providerId, value]) => ({ providerId, type: value.type }),
          );
        },
        modify: (provider, fn, options) =>
          Effect.runPromise(
            SynchronizedRef.modifyEffect(
              state,
              Effect.fnUntraced(function* (current) {
                options?.signal?.throwIfAborted();
                const updated = yield* Effect.tryPromise({
                  try: () => fn(structuredClone(current[provider])),
                  catch: (error) => error,
                });
                if (updated === undefined)
                  return [structuredClone(current[provider]), current] as const;
                // Preserve provider-specific OAuth fields, but validate required fields without printing secrets.
                yield* Schema.decodeUnknownEffect(CredentialSchema)(updated).pipe(
                  Effect.mapError(
                    () => new CoreError({ code: "InvalidInput", message: "认证格式无效" }),
                  ),
                );
                const next = { ...current, [provider]: structuredClone(updated) };
                yield* adapter("无法保存认证信息", () =>
                  writeJson(path, { version: 1, credentials: next }),
                );
                return [structuredClone(updated), next] as const;
              }),
            ).pipe(Effect.uninterruptible),
          ),
        delete: (provider, options) =>
          Effect.runPromise(
            SynchronizedRef.modifyEffect(
              state,
              Effect.fnUntraced(function* (current) {
                options?.signal?.throwIfAborted();
                const next = { ...current };
                delete next[provider];
                yield* adapter("无法移除认证信息", () =>
                  writeJson(path, { version: 1, credentials: next }),
                );
                return [undefined, next] as const;
              }),
            ).pipe(Effect.uninterruptible),
          ),
      };
      return CredentialService.of({
        store,
        export: SynchronizedRef.get(state).pipe(Effect.map((value) => structuredClone(value))),
        import: (values) =>
          SynchronizedRef.modifyEffect(
            state,
            Effect.fnUntraced(function* (current) {
              yield* Schema.decodeUnknownEffect(
                Schema.Record(Schema.NonEmptyString, CredentialSchema),
              )(values).pipe(
                Effect.mapError(
                  () => new CoreError({ code: "InvalidInput", message: "认证格式无效" }),
                ),
              );
              const next = { ...current, ...structuredClone(values as Record<string, Credential>) };
              yield* adapter("无法保存认证信息", () =>
                writeJson(path, { version: 1, credentials: next }),
              );
              return [undefined, next] as const;
            }),
          ).pipe(Effect.uninterruptible),
        list: adapter("无法列出认证信息", () => store.list()),
        setApiKey: (providerId, key) =>
          !providerId.trim() || !key.trim()
            ? Effect.fail(
                new CoreError({
                  code: "InvalidInput",
                  message: "Provider 和 API key 不能为空",
                }),
              )
            : adapter("无法保存 API key", async () => {
                await store.modify(providerId, async () => ({ type: "api_key", key }));
              }),
        remove: (providerId) => adapter("无法移除认证信息", () => store.delete(providerId)),
        importOnce: (source) =>
          SynchronizedRef.modifyEffect(
            state,
            Effect.fnUntraced(function* (current) {
              if ((yield* adapter("无法读取认证文件", () => readJson(path))) !== undefined)
                return [undefined, current] as const;
              const next = { ...current };
              yield* adapter("无法导入已有认证", async () => {
                for (const { providerId } of await source.list()) {
                  const value = await source.read(providerId);
                  if (value) next[providerId] = value;
                }
                await writeJson(path, { version: 1, credentials: next });
              });
              return [undefined, next] as const;
            }),
          ).pipe(Effect.uninterruptible),
      });
    }),
  );
}
