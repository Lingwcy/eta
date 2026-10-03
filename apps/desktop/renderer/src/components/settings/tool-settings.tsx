import { FileSearch, FilePlus2, FilePenLine, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { builtinTools, type BuiltinToolName } from "../../../../src/tools.ts";
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
  return (
    <>
      <SettingsSection title="系统工具">
        {builtinTools.map((tool) => {
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
                aria-label={`${tool.name}（${tool.id}）`}
                aria-pressed={enabled}
                onClick={() =>
                  onChange(
                    enabled
                      ? [...disabledTools, tool.id]
                      : disabledTools.filter((id) => id !== tool.id),
                  )
                }
              >
                {enabled ? "已启用" : "已停用"}
              </Button>
            </SettingsRow>
          );
        })}
      </SettingsSection>
      <SettingsSection title="外部工具">
        <SettingsRow title="暂无外部工具" description="外部工具接入尚未开放。">
          {null}
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
