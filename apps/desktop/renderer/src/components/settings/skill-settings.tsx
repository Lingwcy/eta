import { useEffect, useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { SkillCatalog } from "../../../../src/skills/types.ts";
import type { DesktopSettings } from "../../../../src/shared/settings.ts";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { SettingsRow, SettingsSection } from "./settings-section";

export function SkillSettings({
  library,
  busy,
  active,
  onChange,
}: {
  library: DesktopLibrary;
  busy: boolean;
  active: boolean;
  onChange: (patch: Partial<DesktopSettings>) => Promise<void>;
}) {
  const [cwd, setCwd] = useState("");
  const [catalog, setCatalog] = useState<SkillCatalog>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [openingDirectory, setOpeningDirectory] = useState<string>();
  const settings = library.settings;
  const openDirectory = async (path: string) => {
    setOpeningDirectory(path);
    setError(undefined);
    try {
      await window.eta.openSkillsDirectory(path, cwd || undefined);
      setRevision((value) => value + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法打开技能目录");
    } finally {
      setOpeningDirectory(undefined);
    }
  };
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    window.eta
      .skills(cwd || undefined)
      .then((value) => {
        if (!cancelled) setCatalog(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(error instanceof Error ? error.message : "无法读取技能");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    cwd,
    revision,
    settings.skillDirectories,
    settings.disabledSkills,
    settings.skillsEnabled,
  ]);
  return (
    <>
      {error && <Alert>{error}</Alert>}
      <SettingsSection title="技能">
        <SettingsRow
          title="按需加载技能"
          description="先向 agent 提供名称和描述，使用时再加载技能说明及所需资源。"
        >
          <Button
            size="sm"
            variant={settings.skillsEnabled !== false ? "secondary" : "outline"}
            disabled={busy}
            aria-pressed={settings.skillsEnabled !== false}
            onClick={() => void onChange({ skillsEnabled: settings.skillsEnabled === false })}
          >
            {settings.skillsEnabled !== false ? "已启用" : "已停用"}
          </Button>
        </SettingsRow>
        <SettingsRow
          title="查看范围"
          description="用户技能来自 ~/.agents/skills，项目技能来自项目中的 .agents/skills。"
        >
          <select
            aria-label="技能项目范围"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            className="max-w-56 rounded-lg border border-neutral-200 px-2 py-1.5 text-xs"
          >
            <option value="">用户与自定义目录</option>
            {library.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.cwd}>
                {workspace.cwd}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow
          title="刷新技能目录"
          description="目录改动在下一次请求前重新发现；已加载的技能说明保留到移除为止。"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            {loading ? "正在刷新…" : "刷新"}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="技能目录">
        {catalog?.directories.map(({ path, source, configuredPaths }) => (
          <SettingsRow
            key={path}
            title={path}
            description={{ user: "用户目录", custom: "自定义目录", project: "项目目录" }[source]}
          >
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || loading || Boolean(openingDirectory)}
                aria-label={`打开技能目录 ${path}`}
                onClick={() => void openDirectory(path)}
              >
                {openingDirectory === path ? "正在打开…" : "打开目录"}
              </Button>
              {configuredPaths && (
                <Button
                  variant="ghost-destructive"
                  size="sm"
                  disabled={busy || loading || Boolean(openingDirectory)}
                  onClick={() =>
                    void onChange({
                      skillDirectories: settings.skillDirectories?.filter(
                        (value) => !configuredPaths.includes(value),
                      ),
                    })
                  }
                >
                  移除自定义配置
                </Button>
              )}
            </div>
          </SettingsRow>
        ))}
        <SettingsRow
          title="添加技能目录"
          description="选择包含技能文件夹的目录，也可以直接选择单个技能文件夹。打开尚不存在的目录时会自动创建。"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              void window.eta
                .chooseDirectory()
                .then((path) => {
                  if (path)
                    return onChange({
                      skillDirectories: [...new Set([...(settings.skillDirectories ?? []), path])],
                    });
                })
                .catch((error: unknown) =>
                  setError(error instanceof Error ? error.message : "无法添加目录"),
                );
            }}
          >
            添加目录
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="可用技能">
        {catalog?.skills.map((skill) => (
          <SettingsRow
            key={skill.id}
            title={skill.name}
            description={
              <>
                {skill.description}
                <br />
                {skill.path}
                {skill.shadowedBy && (
                  <>
                    <br />
                    已被 {skill.shadowedBy} 覆盖
                  </>
                )}
                {skill.compatibility && (
                  <>
                    <br />
                    {skill.compatibility}
                  </>
                )}
              </>
            }
          >
            <Button
              variant={skill.enabled ? "secondary" : "outline"}
              size="sm"
              disabled={busy || settings.skillsEnabled === false || Boolean(skill.shadowedBy)}
              aria-pressed={skill.enabled}
              aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`}
              onClick={() =>
                void onChange({
                  disabledSkills: skill.enabled
                    ? [...(settings.disabledSkills ?? []), skill.id]
                    : (settings.disabledSkills ?? []).filter((id) => id !== skill.id),
                })
              }
            >
              {skill.shadowedBy ? "已覆盖" : skill.enabled ? "已启用" : "已停用"}
            </Button>
          </SettingsRow>
        ))}
        {!catalog?.skills.length && (
          <SettingsRow
            title={loading ? "正在发现技能…" : "未发现技能"}
            description="把包含 SKILL.md 的技能文件夹放入技能目录。"
          >
            {null}
          </SettingsRow>
        )}
        {catalog?.issues.map((issue) => (
          <SettingsRow key={issue.path} title={issue.path} description={issue.message}>
            {null}
          </SettingsRow>
        ))}
      </SettingsSection>
    </>
  );
}
