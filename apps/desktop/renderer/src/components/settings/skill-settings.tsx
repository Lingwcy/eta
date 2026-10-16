import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { SkillCatalog } from "@eta/core/skills/types";
import type { DesktopSettings } from "../../../../src/shared/settings.ts";
import { Button } from "@/components/ui/button";
import { ToastNotice } from "@/components/ui/toast";
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
  useTranslation();
  const [cwd, setCwd] = useState("");
  const [catalog, setCatalog] = useState<SkillCatalog>();
  const [error, setError] = useState<Message>();
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
      setError(
        describeError(
          error,
          localizedMessage("settings:skillSettings.cannotOpenTheSkillDirectory"),
        ),
      );
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
        if (!cancelled)
          setError(
            describeError(error, localizedMessage("settings:skillSettings.cannotReadSkills")),
          );
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
      <ToastNotice message={error} />
      <SettingsSection title={t("settings:skillSettings.skills")}>
        <SettingsRow
          title={t("settings:skillSettings.loadSkillsOnDemand")}
          description={t("settings:skillSettings.provideTheAgentWithNamesAndDescriptions")}
        >
          <Button
            size="sm"
            variant={settings.skillsEnabled !== false ? "secondary" : "outline"}
            disabled={busy}
            aria-pressed={settings.skillsEnabled !== false}
            onClick={() => void onChange({ skillsEnabled: settings.skillsEnabled === false })}
          >
            {settings.skillsEnabled !== false
              ? t("settings:skillSettings.enabled")
              : t("settings:skillSettings.disabled")}
          </Button>
        </SettingsRow>
        <SettingsRow
          title={t("settings:skillSettings.scope")}
          description={t("settings:skillSettings.userSkillsComeFromAgentsSkillsProject")}
        >
          <select
            aria-label={t("settings:skillSettings.skillProjectScope")}
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            className="max-w-56 rounded-lg border border-neutral-200 px-2 py-1.5 text-xs"
          >
            <option value="">{t("settings:skillSettings.userAndCustomDirectories")}</option>
            {library.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.cwd}>
                {workspace.cwd}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow
          title={t("settings:skillSettings.refreshSkillDirectories")}
          description={t("settings:skillSettings.directoryChangesAreDiscoveredBeforeTheNext")}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            {loading ? t("settings:skillSettings.refreshing") : t("settings:skillSettings.refresh")}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings:skillSettings.skillDirectories")}>
        {catalog?.directories.map(({ path, source, configuredPaths }) => (
          <SettingsRow
            key={path}
            title={path}
            description={
              {
                user: t("settings:skillSettings.userDirectory"),
                custom: t("settings:skillSettings.customDirectory"),
                project: t("settings:skillSettings.projectDirectory"),
              }[source]
            }
          >
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || loading || Boolean(openingDirectory)}
                aria-label={t("settings:skillSettings.openSkillDirectory", { path: path })}
                onClick={() => void openDirectory(path)}
              >
                {openingDirectory === path
                  ? t("settings:skillSettings.opening")
                  : t("settings:skillSettings.openDirectory")}
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
                  {t("settings:skillSettings.removeCustomConfiguration")}
                </Button>
              )}
            </div>
          </SettingsRow>
        ))}
        <SettingsRow
          title={t("settings:skillSettings.addASkillDirectory")}
          description={t("settings:skillSettings.chooseADirectoryContainingSkillFoldersOr")}
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
                  setError(
                    describeError(
                      error,
                      localizedMessage("settings:skillSettings.cannotAddTheDirectory"),
                    ),
                  ),
                );
            }}
          >
            {t("settings:skillSettings.addDirectory")}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings:skillSettings.availableSkills")}>
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
                    {t("settings:skillSettings.overriddenBy", { path: skill.shadowedBy })}
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
              aria-label={`${skill.enabled ? t("settings:skillSettings.disable") : t("settings:skillSettings.enable")} ${skill.name}`}
              onClick={() =>
                void onChange({
                  disabledSkills: skill.enabled
                    ? [...(settings.disabledSkills ?? []), skill.id]
                    : (settings.disabledSkills ?? []).filter((id) => id !== skill.id),
                })
              }
            >
              {skill.shadowedBy
                ? t("settings:skillSettings.overridden")
                : skill.enabled
                  ? t("settings:skillSettings.enabled")
                  : t("settings:skillSettings.disabled")}
            </Button>
          </SettingsRow>
        ))}
        {!catalog?.skills.length && (
          <SettingsRow
            title={
              loading
                ? t("settings:skillSettings.discoveringSkills")
                : t("settings:skillSettings.noSkillsFound")
            }
            description={t("settings:skillSettings.placeSkillFoldersContainingSkillMdIn")}
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
