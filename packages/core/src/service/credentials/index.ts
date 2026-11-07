import { randomUUID } from "node:crypto";
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
    expires: Schema.Number.check(Schema.isFinite()),
  }),
]);
const FileSchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Record(Schema.String, CredentialSchema),
  accountConnections: Schema.optionalKey(Schema.Record(Schema.String, Schema.NonEmptyString)),
});

type CredentialState = {
  credentials: Record<string, Credential>;
  accountConnections: Record<string, string>;
};

function stored(state: CredentialState) {
  return {
    version: 1,
    credentials: state.credentials,
    ...(Object.keys(state.accountConnections).length
      ? { accountConnections: state.accountConnections }
      : {}),
  };
}

function credentialFor(values: Record<string, Credential>, provider: string) {
  return Object.hasOwn(values, provider) ? values[provider] : undefined;
}

export class CredentialService extends Context.Service<
  CredentialService,
  {
    readonly store: CredentialStore;
    readonly loginStore: CredentialStore;
    subscribe(listener: () => void): () => void;
    isAccountConnection(providerId: string, connectionId: string): boolean;
    readonly accountConnections: Effect.Effect<
      ReadonlyArray<{ providerId: string; connectionId: string }>,
      CoreError
    >;
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
          ? { credentials: {}, accountConnections: {} }
          : yield* Effect.gen(function* () {
              const file = yield* Schema.decodeUnknownEffect(FileSchema)(raw).pipe(
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
              const credentials = source.credentials as Record<string, Credential>;
              const accountConnections = file.accountConnections ?? {};
              if (
                Object.keys(accountConnections).some(
                  (id) => credentialFor(credentials, id)?.type !== "oauth",
                )
              )
                return yield* new CoreError({
                  code: "StorageCorrupt",
                  message: "认证文件格式无效",
                });
              return { credentials, accountConnections };
            });
      const state = yield* SynchronizedRef.make<CredentialState>(initial);
      let committedConnections = initial.accountConnections;
      const listeners = new Set<() => void>();
      const notify = () => {
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* A subscriber cannot roll back a committed credential write. */
          }
        }
      };
      // pi-ai refreshes OAuth inside modify; the same lock also covers login and logout.
      const makeStore = (login: boolean): CredentialStore => ({
        read: async (provider, options) => {
          options?.signal?.throwIfAborted();
          return structuredClone(
            credentialFor(
              (await Effect.runPromise(SynchronizedRef.get(state))).credentials,
              provider,
            ),
          );
        },
        list: async (options) => {
          options?.signal?.throwIfAborted();
          return Object.entries(
            (await Effect.runPromise(SynchronizedRef.get(state))).credentials,
          ).map(([providerId, value]) => ({ providerId, type: value.type }));
        },
        modify: (provider, fn, options) =>
          Effect.runPromise(
            SynchronizedRef.modifyEffect(
              state,
              Effect.fnUntraced(function* (current) {
                options?.signal?.throwIfAborted();
                const updated = yield* Effect.tryPromise({
                  try: () => fn(structuredClone(credentialFor(current.credentials, provider))),
                  catch: (error) => error,
                });
                if (updated === undefined)
                  return [
                    {
                      value: structuredClone(credentialFor(current.credentials, provider)),
                      changed: false as boolean,
                    },
                    current,
                  ] as const;
                // Preserve provider-specific OAuth fields, but validate required fields without printing secrets.
                yield* Schema.decodeUnknownEffect(CredentialSchema)(updated).pipe(
                  Effect.mapError(
                    () => new CoreError({ code: "InvalidInput", message: "认证格式无效" }),
                  ),
                );
                const accountConnections = { ...current.accountConnections };
                if (updated.type !== "oauth") delete accountConnections[provider];
                else if (login)
                  Object.defineProperty(accountConnections, provider, {
                    value: randomUUID(),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                  });
                const next = {
                  credentials: { ...current.credentials, [provider]: structuredClone(updated) },
                  accountConnections,
                };
                yield* adapter("无法保存认证信息", () => writeJson(path, stored(next)));
                committedConnections = next.accountConnections;
                return [
                  {
                    value: structuredClone(updated),
                    changed:
                      (login && updated.type === "oauth") ||
                      (updated.type !== "oauth" &&
                        Object.hasOwn(current.accountConnections, provider)),
                  },
                  next,
                ] as const;
              }),
            ).pipe(Effect.uninterruptible),
          ).then(({ value, changed }) => {
            if (changed) notify();
            return value;
          }),
        delete: (provider, options) =>
          Effect.runPromise(
            SynchronizedRef.modifyEffect(
              state,
              Effect.fnUntraced(function* (current) {
                options?.signal?.throwIfAborted();
                const next = {
                  credentials: { ...current.credentials },
                  accountConnections: { ...current.accountConnections },
                };
                delete next.credentials[provider];
                delete next.accountConnections[provider];
                yield* adapter("无法移除认证信息", () => writeJson(path, stored(next)));
                committedConnections = next.accountConnections;
                return [Object.hasOwn(current.accountConnections, provider), next] as const;
              }),
            ).pipe(Effect.uninterruptible),
          ).then((changed) => {
            if (changed) notify();
          }),
      });
      const store = makeStore(false);
      const loginStore = makeStore(true);
      return CredentialService.of({
        store,
        loginStore,
        isAccountConnection: (providerId, connectionId) =>
          Object.hasOwn(committedConnections, providerId) &&
          committedConnections[providerId] === connectionId,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        accountConnections: SynchronizedRef.get(state).pipe(
          Effect.map(({ accountConnections }) =>
            Object.entries(accountConnections).map(([providerId, connectionId]) => ({
              providerId,
              connectionId,
            })),
          ),
        ),
        export: SynchronizedRef.get(state).pipe(
          Effect.map((value) => structuredClone(value.credentials)),
        ),
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
              const incoming = structuredClone(values as Record<string, Credential>);
              const accountConnections = { ...current.accountConnections };
              for (const provider of Object.keys(incoming)) delete accountConnections[provider];
              const next = {
                credentials: { ...current.credentials, ...incoming },
                accountConnections,
              };
              yield* adapter("无法保存认证信息", () => writeJson(path, stored(next)));
              committedConnections = next.accountConnections;
              return [
                Object.keys(incoming).some((provider) =>
                  Object.hasOwn(current.accountConnections, provider),
                ),
                next,
              ] as const;
            }),
          ).pipe(
            Effect.uninterruptible,
            Effect.tap((changed) =>
              Effect.sync(() => {
                if (changed) notify();
              }),
            ),
            Effect.asVoid,
          ),
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
                return [false, current] as const;
              const next = yield* adapter("无法导入已有认证", async () => {
                const entries = Object.entries(current.credentials);
                for (const { providerId } of await source.list()) {
                  const value = await source.read(providerId);
                  if (value) {
                    if (!Schema.is(CredentialSchema)(value))
                      throw new CoreError({ code: "InvalidInput", message: "认证格式无效" });
                    entries.push([providerId, value]);
                  }
                }
                const imported = Object.fromEntries(entries);
                const next = { credentials: imported, accountConnections: {} };
                await writeJson(path, stored(next));
                return next;
              });
              committedConnections = next.accountConnections;
              return [Object.keys(current.accountConnections).length > 0, next] as const;
            }),
          ).pipe(
            Effect.uninterruptible,
            Effect.tap((changed) =>
              Effect.sync(() => {
                if (changed) notify();
              }),
            ),
            Effect.asVoid,
          ),
      });
    }),
  );
}
