import { SubagentSettingsSchema } from "../subagents/schema.ts";
import { agentThinkingVariants } from "../../../appearance.ts";
import { builtinToolNames } from "../../../tools.ts";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect";
import { AppPathsService } from "../../platform/app-paths.ts";
import { adapter, DesktopServiceError } from "../errors.ts";
import { readJson, writeJson } from "../json-file.ts";
import { ModelCatalogService } from "../models/index.ts";

export const TitleModelSchema = Schema.NullOr(
  Schema.Struct({ provider: Schema.NonEmptyString, modelId: Schema.NonEmptyString }),
);

export const SettingsSchema = Schema.Struct({
  subagents: Schema.optionalKey(SubagentSettingsSchema),
  defaultProvider: Schema.optionalKey(Schema.NonEmptyString),
  defaultModel: Schema.optionalKey(Schema.NonEmptyString),
  titleModel: Schema.optionalKey(TitleModelSchema),
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
  skillsEnabled: Schema.optionalKey(Schema.Boolean),
  skillDirectories: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  disabledSkills: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  blockImages: Schema.optionalKey(Schema.Boolean),
  agentThinkingVariant: Schema.optionalKey(Schema.Literals(agentThinkingVariants)),
  activeThreadId: Schema.optionalKey(Schema.NonEmptyString),
  autoCheckUpdates: Schema.optionalKey(Schema.Boolean),
});
export type DesktopSettings = typeof SettingsSchema.Type;
const FileSchema = Schema.Struct({ version: Schema.Literal(1), settings: SettingsSchema });

export class DesktopSettingsService extends Context.Service<
  DesktopSettingsService,
  {
    readonly read: Effect.Effect<DesktopSettings>;
    subscribe(listener: () => void): () => void;
    update(patch: Partial<DesktopSettings>): Effect.Effect<DesktopSettings, DesktopServiceError>;
  }
>()("eta/desktop/main/service/settings/DesktopSettingsService") {
  static readonly layer = Layer.effect(
    DesktopSettingsService,
    Effect.gen(function* () {
      const { settingsPath } = yield* AppPathsService;
      const { models } = yield* ModelCatalogService;
      const normalize = (settings: DesktopSettings) => {
        const model =
          settings.defaultProvider && settings.defaultModel
            ? models.getModel(settings.defaultProvider, settings.defaultModel)
            : undefined;
        return model
          ? {
              ...settings,
              defaultThinkingLevel: clampThinkingLevel(model, settings.defaultThinkingLevel),
            }
          : settings;
      };
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
      const state = yield* SynchronizedRef.make<DesktopSettings>(normalize(initial));
      const listeners = new Set<() => void>();
      return DesktopSettingsService.of({
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        read: SynchronizedRef.get(state).pipe(Effect.map((value) => structuredClone(value))),
        update: (patch) =>
          SynchronizedRef.modifyEffect(
            state,
            Effect.fnUntraced(function* (current) {
              const decoded = yield* Schema.decodeUnknownEffect(SettingsSchema, {
                onExcessProperty: "error",
              })({ ...current, ...patch }).pipe(
                Effect.mapError(
                  () => new DesktopServiceError({ code: "InvalidInput", message: "设置格式无效" }),
                ),
              );
              if (decoded.subagents) {
                if (decoded.subagents.mode === "orchestrator" && decoded.subagents.maxDepth === 0)
                  return yield* new DesktopServiceError({
                    code: "InvalidInput",
                    message: "编排模式至少需要一层子智能体",
                  });
                const names = decoded.subagents.presets.map((preset) => preset.name);
                if (
                  new Set(names).size !== names.length ||
                  names.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name))
                )
                  return yield* new DesktopServiceError({
                    code: "InvalidInput",
                    message: "预设名称必须唯一，且只能包含字母、数字、下划线和连字符",
                  });
              }
              const next = normalize(decoded);
              yield* adapter("无法保存设置", () =>
                writeJson(settingsPath, { version: 1, settings: next }),
              );
              return [structuredClone(next), next] as const;
            }),
          ).pipe(
            Effect.uninterruptible,
            Effect.tap(() =>
              Effect.sync(() => {
                for (const listener of listeners) listener();
              }),
            ),
          ),
      });
    }),
  );
}
