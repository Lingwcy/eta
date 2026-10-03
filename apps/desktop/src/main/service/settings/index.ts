import { builtinToolNames } from "../../../tools.ts";
import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect";
import { AppPathsService } from "../../platform/app-paths.ts";
import { adapter, DesktopServiceError } from "../errors.ts";
import { readJson, writeJson } from "../json-file.ts";

export const SettingsSchema = Schema.Struct({
  defaultProvider: Schema.optionalKey(Schema.NonEmptyString),
  defaultModel: Schema.optionalKey(Schema.NonEmptyString),
  defaultThinkingLevel: Schema.Literals([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]),
  disabledTools: Schema.optionalKey(Schema.Array(Schema.Literals(builtinToolNames))),
  blockImages: Schema.optionalKey(Schema.Boolean),
  activeThreadId: Schema.optionalKey(Schema.NonEmptyString),
});
export type DesktopSettings = typeof SettingsSchema.Type;
const FileSchema = Schema.Struct({ version: Schema.Literal(1), settings: SettingsSchema });

export class DesktopSettingsService extends Context.Service<
  DesktopSettingsService,
  {
    readonly read: Effect.Effect<DesktopSettings>;
    update(patch: Partial<DesktopSettings>): Effect.Effect<DesktopSettings, DesktopServiceError>;
  }
>()("eta/desktop/main/service/settings/DesktopSettingsService") {
  static readonly layer = Layer.effect(
    DesktopSettingsService,
    Effect.gen(function* () {
      const { settingsPath } = yield* AppPathsService;
      const raw = yield* adapter("无法读取设置", () => readJson(settingsPath));
      const initial =
        raw === undefined
          ? { defaultThinkingLevel: "off" as const }
          : (yield* Schema.decodeUnknownEffect(FileSchema)(raw).pipe(
              Effect.mapError(
                () =>
                  new DesktopServiceError({
                    code: "StorageCorrupt",
                    message: "设置文件格式或版本无效",
                  }),
              ),
            )).settings;
      const state = yield* SynchronizedRef.make<DesktopSettings>(initial);
      return DesktopSettingsService.of({
        read: SynchronizedRef.get(state).pipe(Effect.map((value) => structuredClone(value))),
        update: (patch) =>
          SynchronizedRef.modifyEffect(
            state,
            Effect.fnUntraced(function* (current) {
              const next = yield* Schema.decodeUnknownEffect(SettingsSchema, {
                onExcessProperty: "error",
              })({ ...current, ...patch }).pipe(
                Effect.mapError(
                  () => new DesktopServiceError({ code: "InvalidInput", message: "设置格式无效" }),
                ),
              );
              yield* adapter("无法保存设置", () =>
                writeJson(settingsPath, { version: 1, settings: next }),
              );
              return [structuredClone(next), next] as const;
            }),
          ).pipe(Effect.uninterruptible),
      });
    }),
  );
}
