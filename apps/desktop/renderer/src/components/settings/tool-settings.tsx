import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { FileSearch, FilePlus2, FilePenLine, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BuiltinToolName } from "@eta/core/tools";
import { builtinToolNames } from "@eta/core/tools";
import { SettingsSection, SettingsRow } from "./settings-section";

const icons = { read: FileSearch, write: FilePlus2, edit: FilePenLine, bash: Terminal };

export function ToolSettings({
  disabledTools,
  busy,
  onChange,
}: {
  disabledTools: readonly BuiltinToolName[];
  busy: boolean;
  onChange: (disabled: BuiltinToolName[]) => void;
}) {
  useTranslation();
  return (
    <>
      <SettingsSection title={t("settings:toolSettings.systemTools")}>
        {builtinToolNames.map((id) => {
          const tool = {
            id,
            name: t(`settings:tools.${id}.name`),
            description: t(`settings:tools.${id}.description`),
          };
          const Icon = icons[tool.id];
          const enabled = !disabledTools.includes(tool.id);
          return (
            <SettingsRow
              key={tool.id}
              title={`${tool.name} · ${tool.id}`}
              description={tool.description}
            >
              <Icon size={18} className="text-neutral-400" aria-hidden="true" />
              <Button
                variant={enabled ? "secondary" : "outline"}
                size="sm"
                disabled={busy}
                aria-label={t("settings:toolSettings.toolLabel", { name: tool.name, id: tool.id })}
                aria-pressed={enabled}
                onClick={() =>
                  onChange(
                    enabled
                      ? [...disabledTools, tool.id]
                      : disabledTools.filter((id) => id !== tool.id),
                  )
                }
              >
                {enabled ? t("settings:toolSettings.enabled") : t("settings:toolSettings.disabled")}
              </Button>
            </SettingsRow>
          );
        })}
      </SettingsSection>
      <SettingsSection title={t("settings:toolSettings.externalTools")}>
        <SettingsRow
          title={t("settings:toolSettings.noExternalToolsYet")}
          description={t("settings:toolSettings.externalToolIntegrationIsNotAvailableYet")}
        >
          {null}
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
