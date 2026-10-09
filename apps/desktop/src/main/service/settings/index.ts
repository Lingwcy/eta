import { SettingsSchema } from "../../../shared/settings-schema.ts";
import type { DesktopSettings } from "../../../shared/settings.ts";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect";
import { AppPathsService } from "@eta/core/platform/app-paths";
import { adapter, CoreError } from "@eta/core/service/errors";
import { readJson, writeJson } from "@eta/core/service/json-file";
import { ModelCatalogService } from "../models/index.ts";

const FileSchema = Schema.Struct({ version: Schema.Literal(1), settings: SettingsSchema });

export class DesktopSettingsService extends Context.Service<
  DesktopSettingsService,
  {
    readonly read: Effect.Effect<DesktopSettings>;
    subscribe(listener: () => void): () => void;
    update(patch: Partial<DesktopSettings>): Effect.Effect<DesktopSettings, CoreError>;
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
                  new CoreError({
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
                  () => new CoreError({ code: "InvalidInput", message: "设置格式无效" }),
                ),
              );
              if (decoded.subagents) {
                if (decoded.subagents.mode === "orchestrator" && decoded.subagents.maxDepth === 0)
                  return yield* new CoreError({
                    code: "InvalidInput",
                    message: "编排模式至少需要一层子智能体",
                  });
                const names = decoded.subagents.presets.map((preset) => preset.name);
                if (
                  new Set(names).size !== names.length ||
                  names.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name))
                )
                  return yield* new CoreError({
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
