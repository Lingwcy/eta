import { settingsPanels } from "./settings/settings-panels";
import type { SettingsPanelProps } from "./settings/settings-panels";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Tabs, TabsPanel } from "@/components/ui/tabs";
import { DesktopLayout } from "./desktop-layout";
import { NavigationRail } from "./sidebar/navigation-rail";
import { SettingsSidebar } from "./settings/settings-sidebar";
import { SettingsPage } from "./settings/settings-page";
import type { SettingsItem } from "./settings/settings-categories";
import { settingsGroups } from "./settings/settings-categories";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Props extends Omit<SettingsPanelProps, "active"> {
  active?: boolean;
  inspectorOpen?: boolean;
  initialCategory?: string;
  categoryRevision?: number;
  onChooseProject: () => void;
  error: string | null;
  onClose: () => void;
}
export function DesktopSettings(props: Props) {
  const [category, setCategory] = useState(
    props.initialCategory ??
      (props.library.credentials.find(
        (credential) => credential.providerId === props.library.settings.defaultProvider,
      )?.type === "api_key"
        ? "api-keys"
        : "accounts"),
  );
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (props.initialCategory) setCategory(props.initialCategory);
  }, [props.initialCategory, props.categoryRevision]);
  useEffect(() => {
    if (props.active === false) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose, props.active]);
  return (
    <Tabs
      value={category}
      onValueChange={(value) => setCategory(String(value))}
      orientation="vertical"
      className="contents"
    >
      <DesktopLayout
        collapsed={false}
        inspectorOpen={props.inspectorOpen}
        sidebar={
          <>
            <NavigationRail
              archived={false}
              settingsActive
              busy={props.busy}
              onHome={props.onClose}
              onChoose={() => {
                props.onClose();
                props.onChooseProject();
              }}
              onSettings={(next) => setCategory(next ?? "accounts")}
            />
            <SettingsSidebar query={query} onQuery={setQuery} onClose={props.onClose} />
          </>
        }
      >
        <ScrollArea className="flex-1">
          {settingsGroups
            .flatMap<SettingsItem>((group) => group.items)
            .map((item) => (
              <TabsPanel key={item.id} value={item.id}>
                <SettingsPage title={item.id === "storage" ? undefined : item.title}>
                  {props.error && (
                    <div className="mb-4">
                      <Alert>{props.error}</Alert>
                    </div>
                  )}
                  {settingsPanels[item.id]({
                    ...props,
                    active: props.active !== false && category === item.id,
                  })}
                </SettingsPage>
              </TabsPanel>
            ))}
        </ScrollArea>
      </DesktopLayout>
    </Tabs>
  );
}
