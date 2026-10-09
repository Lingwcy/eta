import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import type { SkillCatalog } from "../../skills/types.ts";
import { RuntimeSettingsService } from "../settings/index.ts";
import { adapter, CoreError } from "../errors.ts";
import { discoverSkills } from "./catalog.ts";

export class SkillsService extends Context.Service<
  SkillsService,
  {
    catalog(cwd?: string): Effect.Effect<SkillCatalog, CoreError>;
    prepareDirectory(path: string, cwd?: string): Effect.Effect<string, CoreError>;
  }
>()("eta/core/service/skills/SkillsService") {
  static readonly layerWith = (home: string) =>
    Layer.effect(
      SkillsService,
      Effect.gen(function* () {
        const settings = yield* RuntimeSettingsService;
        const catalog = Effect.fn("SkillsService.catalog")(function* (cwd?: string) {
          const preferences = yield* settings.read;
          const sources = [
            { path: join(home, ".agents", "skills"), source: "user" as const, optional: true },
            ...(preferences.skillDirectories ?? []).map((path) => ({
              path: path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(path),
              source: "custom" as const,
              configuredPath: path,
            })),
            ...(cwd
              ? [
                  {
                    path: join(cwd, ".agents", "skills"),
                    source: "project" as const,
                    optional: true,
                  },
                ]
              : []),
          ];
          return yield* adapter("无法发现技能", () =>
            discoverSkills(
              sources,
              preferences.disabledSkills,
              preferences.skillsEnabled !== false,
            ),
          );
        });
        return SkillsService.of({
          catalog,
          prepareDirectory: Effect.fn("SkillsService.prepareDirectory")(function* (
            path: string,
            cwd?: string,
          ) {
            const directory = resolve(path);
            const available = yield* catalog(cwd);
            if (!available.directories.some(({ path }) => path === directory))
              return yield* new CoreError({
                code: "InvalidInput",
                message: "该目录不在当前技能目录中，请刷新后重试",
              });
            yield* adapter("无法创建技能目录，请检查路径和访问权限", () =>
              mkdir(directory, { recursive: true }),
            );
            return directory;
          }),
        });
      }),
    );
}
